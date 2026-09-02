import type { AgentActor } from "../agents/profile-types";
import type { AuditStore } from "../audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  createCredential,
  decryptCredentialForUse,
  revokeCredential,
} from "../credentials";
import type { CursorClient } from "./cursor-client";

export const CLOUD_AGENT_PROVIDER_ID = "cursor" as const;

export type CloudAgentProviderStatus = {
  id: typeof CLOUD_AGENT_PROVIDER_ID;
  name: string;
  description: string;
  authentication: "api-key";
  connected: boolean;
  dashboardUrl: string;
};

export class InvalidCloudAgentCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCloudAgentCredentialError";
  }
}

export type CloudAgentConnectionStore = {
  statuses(actor: AgentActor): Promise<CloudAgentProviderStatus[]>;
  connect(
    actor: AgentActor,
    providerId: string,
    credential: string,
  ): Promise<CloudAgentProviderStatus>;
  disconnect(actor: AgentActor, providerId: string): Promise<void>;
  hasConnection(actorId: string, providerId?: string): Promise<boolean>;
  apiKeyFor(actorId: string, providerId?: string): Promise<string | null>;
};

type Vault = {
  store: CredentialStore;
  reader: CredentialSecretReader;
  encryptionKey: string;
  auditStore: AuditStore;
};

const definition = {
  id: CLOUD_AGENT_PROVIDER_ID,
  name: "Cursor Cloud Agents",
  description:
    "Let your OpenBot agents delegate repository work to isolated Cursor cloud environments.",
  authentication: "api-key" as const,
  dashboardUrl: "https://cursor.com/dashboard?tab=integrations",
};

function providerKey(actorId: string) {
  return {
    kind: "connector" as const,
    provider: CLOUD_AGENT_PROVIDER_ID,
    keyId: actorId,
  };
}

function requireCursor(providerId: string) {
  if (providerId !== CLOUD_AGENT_PROVIDER_ID) {
    throw new InvalidCloudAgentCredentialError(
      "That cloud-agent provider is not available.",
    );
  }
}

export function createCloudAgentConnectionStore(
  vault: Vault,
  cursor: CursorClient,
): CloudAgentConnectionStore {
  const status = async (
    actorId: string,
  ): Promise<CloudAgentProviderStatus> => ({
    ...definition,
    connected: Boolean(await vault.store.findLiveByKey(providerKey(actorId))),
  });

  return {
    async statuses(actor) {
      return [await status(actor.id)];
    },

    async connect(actor, providerId, credential) {
      requireCursor(providerId);
      const apiKey = credential.trim();
      if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
        throw new InvalidCloudAgentCredentialError(
          "Enter a valid Cursor API key.",
        );
      }
      let info: Awaited<ReturnType<CursorClient["keyInfo"]>>;
      try {
        info = await cursor.keyInfo(apiKey);
      } catch {
        throw new InvalidCloudAgentCredentialError(
          "Cursor did not accept that API key.",
        );
      }
      await createCredential(vault, {
        ...providerKey(actor.id),
        metadata: {
          ownerUserId: actor.id,
          authentication: "api-key",
          apiKeyName: info.apiKeyName,
          ...(info.userEmail ? { userEmail: info.userEmail } : {}),
        },
        plaintext: apiKey,
        actorUserId: actor.id,
      });
      return status(actor.id);
    },

    async disconnect(actor, providerId) {
      requireCursor(providerId);
      const stored = await vault.store.findLiveByKey(providerKey(actor.id));
      if (!stored) return;
      await revokeCredential(vault, stored.id, actor.id);
    },

    async hasConnection(actorId, providerId = CLOUD_AGENT_PROVIDER_ID) {
      requireCursor(providerId);
      return Boolean(await vault.store.findLiveByKey(providerKey(actorId)));
    },

    async apiKeyFor(actorId, providerId = CLOUD_AGENT_PROVIDER_ID) {
      requireCursor(providerId);
      const stored = await vault.store.findLiveByKey(providerKey(actorId));
      if (!stored) return null;
      return decryptCredentialForUse(
        vault.encryptionKey,
        vault.reader,
        stored.id,
      );
    },
  };
}
