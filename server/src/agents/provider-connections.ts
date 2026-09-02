import { randomUUID } from "node:crypto";
import type { AuditStore } from "../audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  createCredential,
  decryptCredentialForUse,
  revokeCredential,
} from "../credentials";
import type { AgentActor } from "./profile-types";
import {
  createProviderOAuthBroker,
  type ProviderOAuthBroker,
} from "./provider-oauth";
import {
  AGENT_PROVIDER_CATALOG,
  type AgentProviderAuthentication,
  type AgentProviderId,
  type AgentProviderRuntime,
  agentProviderDefinition,
} from "./providers";

const OAUTH_SESSION_TTL_MS = 15 * 60 * 1000;
const OAUTH_CONNECTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProviderConnectionStatus = {
  id: AgentProviderId;
  name: string;
  description: string;
  authentication: AgentProviderAuthentication;
  runtimeAvailable: boolean;
  connected: boolean;
  available: boolean;
};

export type ProviderCredential =
  | { authentication: "oauth"; connectionId: string }
  | { authentication: "api-key"; secret: string };

export type ProviderOAuthSession = {
  sessionId: string;
  verificationUrl: string;
  userCode: string;
};

export type ProviderOAuthConnectionStatus =
  | { status: "pending" }
  | { status: "connected"; provider: ProviderConnectionStatus }
  | { status: "failed"; error: string };

export type ProviderConnectionReader = {
  connected(actor: AgentActor, providerId: AgentProviderId): Promise<boolean>;
  credentialFor(
    actor: AgentActor,
    providerId: AgentProviderId,
  ): Promise<ProviderCredential | null>;
  statuses(actor: AgentActor): Promise<ProviderConnectionStatus[]>;
};

export type ProviderConnectionStore = ProviderConnectionReader & {
  connect(
    actor: AgentActor,
    providerId: AgentProviderId,
    credential?: string,
  ): Promise<ProviderConnectionStatus>;
  startOAuth(
    actor: AgentActor,
    providerId: AgentProviderId,
  ): Promise<ProviderOAuthSession>;
  oauthStatus(
    actor: AgentActor,
    providerId: AgentProviderId,
    sessionId: string,
  ): Promise<ProviderOAuthConnectionStatus>;
  cancelOAuth(
    actor: AgentActor,
    providerId: AgentProviderId,
    sessionId: string,
  ): Promise<void>;
  disconnect(actor: AgentActor, providerId: AgentProviderId): Promise<void>;
};

export class UnknownProviderTypeError extends Error {
  constructor(providerId: string) {
    super(`Provider type ${providerId} was not found.`);
    this.name = "UnknownProviderTypeError";
  }
}

export class InvalidProviderCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderCredentialError";
  }
}

type Vault = {
  store: CredentialStore;
  reader: CredentialSecretReader;
  encryptionKey: string;
  auditStore: AuditStore;
};

type OAuthSessionRecord = {
  actorId: string;
  providerId: AgentProviderId;
  connectionId: string;
  loginId: string;
  expiresAt: number;
  result?: ProviderOAuthConnectionStatus;
  inFlight?: Promise<ProviderOAuthConnectionStatus>;
  previousConnectionId?: string;
};

function providerKey(actor: AgentActor, providerId: AgentProviderId) {
  return { kind: "model" as const, provider: providerId, keyId: actor.id };
}

/**
 * A person's model-provider connections.
 *
 * The credential key is the person's user id, never an agent id. Agents choose a provider type;
 * each run resolves the signed-in runner's connection for that type. That is what lets a public
 * agent remain shareable without sharing the account of the person who created it.
 */
export function createProviderConnectionStore(
  configuredProviders: readonly AgentProviderRuntime[],
  vault: Vault,
  oauth: ProviderOAuthBroker = createProviderOAuthBroker(configuredProviders),
): ProviderConnectionStore {
  const runtimeIds = new Set(
    configuredProviders.map((provider) => provider.id),
  );
  const oauthSessions = new Map<string, OAuthSessionRecord>();

  const credentialFor = async (
    actor: AgentActor,
    providerId: AgentProviderId,
  ): Promise<ProviderCredential | null> => {
    const definition = agentProviderDefinition(providerId);
    if (!definition) throw new UnknownProviderTypeError(providerId);
    const stored = await vault.store.findLiveByKey(
      providerKey(actor, providerId),
    );
    if (!stored) return null;
    const secret = await decryptCredentialForUse(
      vault.encryptionKey,
      vault.reader,
      stored.id,
    );
    if (definition.authentication === "oauth") {
      // The previous implementation stored a consent marker for the host account. It was never a
      // real connection and must not survive this contract change as a misleading green status.
      return OAUTH_CONNECTION_ID.test(secret)
        ? { authentication: "oauth", connectionId: secret }
        : null;
    }
    return { authentication: "api-key", secret };
  };

  const isConnected = async (
    actor: AgentActor,
    providerId: AgentProviderId,
  ): Promise<boolean> => {
    const definition = agentProviderDefinition(providerId);
    if (!definition) throw new UnknownProviderTypeError(providerId);
    const stored = await vault.store.findLiveByKey(
      providerKey(actor, providerId),
    );
    if (!stored) return false;
    if (definition.authentication === "api-key") return true;
    const connectionId = await decryptCredentialForUse(
      vault.encryptionKey,
      vault.reader,
      stored.id,
    );
    return OAUTH_CONNECTION_ID.test(connectionId);
  };

  const status = async (
    actor: AgentActor,
    providerId: AgentProviderId,
  ): Promise<ProviderConnectionStatus> => {
    const definition = agentProviderDefinition(providerId);
    if (!definition) throw new UnknownProviderTypeError(providerId);
    const connected = await isConnected(actor, providerId);
    const runtimeAvailable = runtimeIds.has(providerId);
    return {
      ...definition,
      runtimeAvailable,
      connected,
      available: runtimeAvailable && connected,
    };
  };

  const pollOAuthSession = async (
    actor: AgentActor,
    providerId: AgentProviderId,
    session: OAuthSessionRecord,
  ): Promise<ProviderOAuthConnectionStatus> => {
    if (Date.now() >= session.expiresAt) {
      await oauth
        .cancel(providerId, session.connectionId, session.loginId)
        .catch(() => {});
      session.result = {
        status: "failed",
        error: "This authorization request expired. Start a new connection.",
      };
      return session.result;
    }

    const runtimeStatus = await oauth.status(
      providerId,
      session.connectionId,
      session.loginId,
    );
    if (runtimeStatus.status === "pending") return runtimeStatus;
    if (runtimeStatus.status === "failed") {
      await oauth
        .cancel(providerId, session.connectionId, session.loginId)
        .catch(() => {});
      session.result = runtimeStatus;
      return session.result;
    }
    // A cancel can land while the runtime status request is in flight. Cancellation wins: closing
    // the dialog must never connect an account a moment later.
    if (session.result) return session.result;

    const definition = agentProviderDefinition(providerId);
    if (definition?.authentication !== "oauth") {
      throw new UnknownProviderTypeError(providerId);
    }
    await createCredential(vault, {
      ...providerKey(actor, providerId),
      metadata: {
        ownerUserId: actor.id,
        authentication: "oauth",
      },
      plaintext: session.connectionId,
      actorUserId: actor.id,
    });
    session.result = {
      status: "connected",
      provider: await status(actor, providerId),
    };

    if (
      session.previousConnectionId &&
      session.previousConnectionId !== session.connectionId
    ) {
      await oauth
        .disconnect(providerId, session.previousConnectionId)
        .catch(() => {});
    }
    return session.result;
  };

  return {
    async connected(actor, providerId) {
      return isConnected(actor, providerId);
    },

    credentialFor,

    statuses(actor) {
      return Promise.all(
        AGENT_PROVIDER_CATALOG.map((provider) => status(actor, provider.id)),
      );
    },

    async connect(actor, providerId, credential) {
      const definition = agentProviderDefinition(providerId);
      if (!definition) throw new UnknownProviderTypeError(providerId);

      if (definition.authentication !== "api-key") {
        throw new InvalidProviderCredentialError(
          `Connect ${definition.name} through its authorization flow.`,
        );
      }
      const plaintext = credential?.trim() ?? "";
      if (!plaintext) {
        throw new InvalidProviderCredentialError("An API key is required.");
      }
      if (plaintext.length > 4096 || /[\r\n]/.test(plaintext)) {
        throw new InvalidProviderCredentialError("That API key is invalid.");
      }

      await createCredential(vault, {
        ...providerKey(actor, providerId),
        metadata: {
          ownerUserId: actor.id,
          authentication: definition.authentication,
        },
        plaintext,
        actorUserId: actor.id,
      });
      return status(actor, providerId);
    },

    async startOAuth(actor, providerId) {
      const definition = agentProviderDefinition(providerId);
      if (!definition) throw new UnknownProviderTypeError(providerId);
      if (definition.authentication !== "oauth") {
        throw new InvalidProviderCredentialError(
          `${definition.name} uses an API key, not OAuth.`,
        );
      }

      const previous = await credentialFor(actor, providerId);
      const connectionId = randomUUID();
      const started = await oauth.start(providerId, connectionId);
      const sessionId = randomUUID();
      oauthSessions.set(sessionId, {
        actorId: actor.id,
        providerId,
        connectionId,
        loginId: started.loginId,
        expiresAt: Date.now() + OAUTH_SESSION_TTL_MS,
        ...(previous?.authentication === "oauth"
          ? { previousConnectionId: previous.connectionId }
          : {}),
      });
      return {
        sessionId,
        verificationUrl: started.verificationUrl,
        userCode: started.userCode,
      };
    },

    async oauthStatus(actor, providerId, sessionId) {
      const session = ownedOAuthSession(
        oauthSessions,
        actor,
        providerId,
        sessionId,
      );
      if (session.result) return session.result;
      session.inFlight ??= pollOAuthSession(actor, providerId, session);
      try {
        return await session.inFlight;
      } finally {
        session.inFlight = undefined;
      }
    },

    async cancelOAuth(actor, providerId, sessionId) {
      const session = ownedOAuthSession(
        oauthSessions,
        actor,
        providerId,
        sessionId,
      );
      if (!session.result) {
        session.result = {
          status: "failed",
          error: "Authorization was cancelled.",
        };
        await oauth.cancel(providerId, session.connectionId, session.loginId);
      }
    },

    async disconnect(actor, providerId) {
      const definition = agentProviderDefinition(providerId);
      if (!definition) {
        throw new UnknownProviderTypeError(providerId);
      }
      const stored = await vault.store.findLiveByKey(
        providerKey(actor, providerId),
      );
      if (!stored) return;
      if (definition.authentication === "oauth") {
        const connectionId = await decryptCredentialForUse(
          vault.encryptionKey,
          vault.reader,
          stored.id,
        );
        if (OAUTH_CONNECTION_ID.test(connectionId)) {
          await oauth.disconnect(providerId, connectionId);
        }
      }
      await revokeCredential(vault, stored.id, actor.id);
    },
  };
}

function ownedOAuthSession(
  sessions: Map<string, OAuthSessionRecord>,
  actor: AgentActor,
  providerId: AgentProviderId,
  sessionId: string,
): OAuthSessionRecord {
  const session = sessions.get(sessionId);
  if (
    !session ||
    session.actorId !== actor.id ||
    session.providerId !== providerId
  ) {
    throw new InvalidProviderCredentialError(
      "That provider authorization request was not found.",
    );
  }
  return session;
}
