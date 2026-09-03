import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { credentials, mcpServers, mcpTools } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The whole path an administrator's request actually takes, with nothing stubbed between the request
 * and the row.
 *
 * The two halves are covered on their own: the store's refusals against a real database, and the
 * route's mapping of them against a stubbed store. Both passing does not prove the pair is wired
 * together, and the failure that would live in the gap is quiet in exactly the way that matters: a
 * refusal that reaches the browser as a 500 reads as a broken deployment rather than a correctable
 * mistake, and a refusal that stops short of the write leaves a row pointing at a credential the
 * next refresh spends. So this asks the question end to end and then looks in the table.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    // Never read: Drive's tool list is in this deployment's own code, so the add path here reaches
    // no vault. Loud rather than absent, so a call that starts reaching one is named.
    readSecret: async () => {
      throw new Error("this suite does not read credentials");
    },
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  managedConnector: {
    provider: "composio",
    listToolkits: async () => [
      {
        slug: "googledrive",
        name: "Google Drive",
        description: "Files in the Drive of whoever is asking.",
        logoUrl: null,
        categories: ["Productivity"],
        toolsCount: 0,
      },
      {
        slug: "slack",
        name: "Slack",
        description: "Messages in the Slack of whoever is asking.",
        logoUrl: null,
        categories: ["Communication"],
        toolsCount: 0,
      },
    ],
    beginConnection: async () => {
      throw new Error("not used here");
    },
    connectionsFor: async () => [],
    disconnect: async () => {},
    listTools: async () => [],
    callTool: async () => ({ text: "", isError: false, truncated: false }),
  },
});

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function request(
  body: unknown,
  role: "admin" | "user" = "admin",
  path = "/api/plugins/servers",
) {
  const app = application(role);

  return app.request(`http://openbot.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function application(role: "admin" | "user" = "admin") {
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => [role] },
    // Positions 4-14 are the other stores; the real one is 15, pluginStore.
    ...(Array.from({ length: 11 }) as never[]),
    store as never,
  );
}

const serverId = "google-drive";
const dynamicServerId = "composio-slack";
const suffix = randomUUID().slice(0, 8);
const personalCredentialId = randomUUID();
const customServerId = `route-custom-${suffix}`;
const foreignCredentialId = randomUUID();
const ownCredentialId = randomUUID();

/** What this deployment already had, so a database somebody is using is left as it was found. */
let existing: { credentialId: string | null } | null = null;

beforeAll(async () => {
  const [row] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  existing = row ?? null;

  const encrypted = await encryptSecret(`${"A".repeat(43)}=`, "not-read-here");
  await database.insert(credentials).values([
    {
      id: personalCredentialId,
      kind: "mcp_user_token",
      provider: serverId,
      keyId: `user_someone_else_${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: foreignCredentialId,
      kind: "mcp",
      // Minted for a different server, which is what makes it somebody else's to spend.
      provider: `route-elsewhere-${suffix}`,
      keyId: `mcp-elsewhere-${suffix}`,
      encryptedValue: encrypted,
      metadata: {},
    },
    {
      id: ownCredentialId,
      kind: "mcp",
      provider: customServerId,
      keyId: `mcp-${customServerId}`,
      encryptedValue: encrypted,
      metadata: {},
    },
  ]);
});

afterAll(async () => {
  if (existing) {
    await database
      .update(mcpServers)
      .set({ credentialId: existing.credentialId })
      .where(eq(mcpServers.id, serverId));
  } else {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(mcpTools).where(eq(mcpTools.serverId, customServerId));
  await database.delete(mcpServers).where(eq(mcpServers.id, customServerId));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, dynamicServerId));
  await database.delete(mcpServers).where(eq(mcpServers.id, dynamicServerId));
  await database
    .delete(credentials)
    .where(
      inArray(credentials.id, [
        personalCredentialId,
        foreignCredentialId,
        ownCredentialId,
      ]),
    );
});

async function serverRow() {
  const [row] = await database
    .select({ credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  return row ?? null;
}

describe("adding a curated server over HTTP", () => {
  test("the admin catalogue comes from Composio and preserves OpenBot built-ins", async () => {
    const response = await application().request(
      "http://openbot.test/api/plugins",
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      catalogue: Array<Record<string, unknown>>;
      catalogueError: string | null;
    };
    expect(body.catalogueError).toBeNull();
    expect(body.catalogue).toContainEqual(
      expect.objectContaining({
        key: dynamicServerId,
        title: "Slack",
        source: "composio",
        categories: ["Communication"],
      }),
    );
    expect(body.catalogue).toContainEqual(
      expect.objectContaining({ key: "routines", source: "openbot" }),
    );
  });

  test("a live Composio toolkit can be enabled without an OpenBot release", async () => {
    const response = await request({ key: dynamicServerId });

    expect(response.status).toBe(200);
    expect((await response.json()).server).toMatchObject({
      id: dynamicServerId,
      title: "Slack",
      hasCredential: false,
    });
  });

  test("a crafted Composio key that is absent from the live catalogue is refused", async () => {
    const response = await request({ key: "composio-not-in-catalogue" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "composio-not-in-catalogue is not a server this deployment will connect to.",
    });
  });

  test("a credential of the wrong kind is refused, and nothing is written", async () => {
    const before = await serverRow();

    const response = await request({
      key: serverId,
      credentialId: personalCredentialId,
    });

    // Not a 500. An administrator who picked the wrong row is told what to do about it.
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(
      "takes no credential when it is added",
    );

    // And the refusal stopped the write rather than reporting on it.
    expect(await serverRow()).toEqual(before);
  });

  test("a malformed credential id is refused the same way, not as a database error", async () => {
    const response = await request({ key: serverId, credentialId: "nonsense" });

    expect(response.status).toBe(400);
  });

  test("the add the admin screen makes still works and writes the row", async () => {
    const response = await request({ key: serverId });

    expect(response.status).toBe(200);
    expect((await response.json()).server.id).toBe(serverId);
    // Managed connectors never point at an OAuth client or user token in OpenBot's vault.
    expect(await serverRow()).toEqual({ credentialId: null });
  });

  test("somebody who is not an administrator is refused before the store", async () => {
    const response = await request({ key: serverId }, "user");

    expect(response.status).toBe(403);
  });
});

/**
 * The same two rules, asked over HTTP against the real store.
 *
 * Both are refusals an administrator has to be able to act on, so what they must never be is a 500:
 * "something went wrong" sends somebody to look at the deployment when the answer is to pick a
 * different token or remove the server first.
 */
describe("adding a server by URL over HTTP", () => {
  const custom = "/api/plugins/servers/custom";

  test("another server's token is refused rather than spent", async () => {
    const response = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: foreignCredentialId,
      },
      "admin",
      custom,
    );

    expect(response.status).toBe(400);

    const rows = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, customServerId));
    expect(rows).toHaveLength(0);
  });

  test("re-addressing a server that holds a token is refused", async () => {
    const added = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://legit.vendor.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(added.status).toBe(200);

    const moved = await request(
      {
        id: customServerId,
        title: "Collector",
        url: "https://collector.attacker.example/mcp",
        credentialId: ownCredentialId,
      },
      "admin",
      custom,
    );
    expect(moved.status).toBe(400);

    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, customServerId));
    expect(row?.url).toBe("https://legit.vendor.example/mcp");
  });
});
