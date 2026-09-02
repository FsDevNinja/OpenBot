import { describe, expect, test } from "bun:test";
import type { AgentActor } from "../src/agents/profile-types";
import { createProviderConnectionStore } from "../src/agents/provider-connections";
import type {
  ProviderOAuthBroker,
  ProviderOAuthRuntimeStatus,
} from "../src/agents/provider-oauth";
import { AGENT_PROVIDER_CATALOG } from "../src/agents/providers";
import type {
  CredentialSecretReader,
  CredentialStore,
  CredentialStoreValue,
} from "../src/credentials";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const openaiRuntime = {
  ...AGENT_PROVIDER_CATALOG[1],
  endpoint: new URL("https://openai-runtime.example.test/ag-ui"),
  token: "runtime-token",
};
const codexRuntime = {
  ...AGENT_PROVIDER_CATALOG[0],
  endpoint: new URL("https://codex-runtime.example.test/ag-ui"),
  token: "codex-runtime-token",
};

function memoryOAuth() {
  let status: ProviderOAuthRuntimeStatus = { status: "pending" };
  const disconnected: string[] = [];
  const broker: ProviderOAuthBroker = {
    async start(_providerId, connectionId) {
      return {
        loginId: `login-${connectionId}`,
        verificationUrl: "https://auth.openai.example/device",
        userCode: "ABCD-1234",
      };
    },
    async status() {
      return status;
    },
    async cancel() {},
    async disconnect(_providerId, connectionId) {
      disconnected.push(connectionId);
    },
  };
  return {
    broker,
    connect() {
      status = { status: "connected" };
    },
    disconnected,
  };
}

function memoryVault() {
  let nextId = 0;
  const values = new Map<
    string,
    CredentialStoreValue & { id: string; revokedAt: Date | null }
  >();
  const store: CredentialStore & CredentialSecretReader = {
    async create(value) {
      nextId += 1;
      const id = `credential-${nextId}`;
      values.set(id, { ...value, id, revokedAt: null });
      return { id, revokedAt: null };
    },
    async updateSecret(id, encryptedValue) {
      const value = values.get(id);
      if (!value || value.revokedAt) throw new Error("not live");
      value.encryptedValue = encryptedValue;
    },
    async rotate(input) {
      const previous = values.get(input.previousCredentialId);
      if (!previous || previous.revokedAt) throw new Error("not live");
      previous.revokedAt = new Date();
      nextId += 1;
      const id = `credential-${nextId}`;
      values.set(id, { ...input, id, revokedAt: null });
      return { id, revokedAt: null };
    },
    async revoke(id) {
      const value = values.get(id);
      if (!value || value.revokedAt) throw new Error("not live");
      value.revokedAt = new Date();
      return value.revokedAt;
    },
    async isLive(id) {
      return values.get(id)?.revokedAt === null;
    },
    async findLiveByKey(key) {
      for (const value of values.values()) {
        if (
          value.kind === key.kind &&
          value.provider === key.provider &&
          value.keyId === key.keyId &&
          value.revokedAt === null
        ) {
          return { id: value.id };
        }
      }
      return null;
    },
    async readSecret(id) {
      const value = values.get(id);
      return value
        ? {
            encryptedValue: value.encryptedValue,
            revokedAt: value.revokedAt,
          }
        : null;
    },
  };
  return {
    store,
    reader: store,
    encryptionKey,
    auditStore: { insert: async () => undefined },
  };
}

const alice = { id: "alice", role: "user" } satisfies AgentActor;
const bob = { id: "bob", role: "user" } satisfies AgentActor;

describe("personal provider connections", () => {
  test("keeps one user's API key invisible and unavailable to another user", async () => {
    const connections = createProviderConnectionStore(
      [openaiRuntime],
      memoryVault(),
    );

    await connections.connect(alice, "openai", "alice-secret-key");

    expect(await connections.connected(alice, "openai")).toBe(true);
    expect(await connections.connected(bob, "openai")).toBe(false);
    expect(await connections.credentialFor(alice, "openai")).toEqual({
      authentication: "api-key",
      secret: "alice-secret-key",
    });
    expect(await connections.credentialFor(bob, "openai")).toBeNull();
    expect(JSON.stringify(await connections.statuses(alice))).not.toContain(
      "alice-secret-key",
    );
  });

  test("rotates a user's key and disconnects only that user's provider", async () => {
    const connections = createProviderConnectionStore(
      [openaiRuntime],
      memoryVault(),
    );
    await connections.connect(alice, "openai", "first-key");
    await connections.connect(bob, "openai", "bob-key");

    await connections.connect(alice, "openai", "replacement-key");
    expect(await connections.credentialFor(alice, "openai")).toEqual({
      authentication: "api-key",
      secret: "replacement-key",
    });

    await connections.disconnect(alice, "openai");
    expect(await connections.credentialFor(alice, "openai")).toBeNull();
    expect(await connections.credentialFor(bob, "openai")).toEqual({
      authentication: "api-key",
      secret: "bob-key",
    });
  });

  test("stores a personal Codex connection only after OAuth succeeds", async () => {
    const oauth = memoryOAuth();
    const connections = createProviderConnectionStore(
      [codexRuntime],
      memoryVault(),
      oauth.broker,
    );

    const authorization = await connections.startOAuth(alice, "codex");
    expect(authorization).toMatchObject({
      verificationUrl: "https://auth.openai.example/device",
      userCode: "ABCD-1234",
    });
    expect(await connections.credentialFor(alice, "codex")).toBeNull();
    expect(
      await connections.oauthStatus(alice, "codex", authorization.sessionId),
    ).toEqual({ status: "pending" });

    oauth.connect();
    expect(
      await connections.oauthStatus(alice, "codex", authorization.sessionId),
    ).toMatchObject({ status: "connected" });
    expect(await connections.credentialFor(alice, "codex")).toMatchObject({
      authentication: "oauth",
    });
    expect(await connections.credentialFor(bob, "codex")).toBeNull();
    expect(
      (await connections.statuses(alice)).find(
        (provider) => provider.id === "codex",
      ),
    ).toMatchObject({
      connected: true,
      runtimeAvailable: true,
      available: true,
    });

    const credential = await connections.credentialFor(alice, "codex");
    if (credential?.authentication !== "oauth") throw new Error("not oauth");
    await connections.disconnect(alice, "codex");
    expect(oauth.disconnected).toEqual([credential.connectionId]);
  });
});
