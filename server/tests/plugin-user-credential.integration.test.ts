import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import type { ManagedConnection } from "../src/plugins/managed-connector";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Managed connections preserve the important per-person property without bringing tokens into
 * OpenBot: the stable actor id is the only identity sent to Composio and there is no deployment
 * fallback when it is missing.
 */
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suffix = randomUUID().slice(0, 8);
const serverId = "google-drive";
const botId = `managed_bot_${suffix}`;
const userId = `managed_user_${suffix}`;
const toolName = `GOOGLEDRIVE_TEST_${suffix.toUpperCase()}`;
const ref = `${serverId}/${toolName}`;
const calls: { userId: string; toolkit: string; toolName: string }[] = [];
const disconnected: string[] = [];
const accounts = new Map<string, ManagedConnection[]>([
  [
    userId,
    [
      {
        id: `conn_${suffix}`,
        toolkit: "googledrive",
        status: "ACTIVE",
        connectedAt: "2026-09-02T12:00:00.000Z",
      },
    ],
  ],
]);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => {
      throw new Error("managed calls must not read the OpenBot vault");
    },
    create: async () => {
      throw new Error("managed calls must not write the OpenBot vault");
    },
    revoke: async () => {
      throw new Error("managed calls must not revoke the OpenBot vault");
    },
  },
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  managedConnector: {
    provider: "composio",
    listToolkits: async () => [],
    beginConnection: async () => {
      throw new Error("not used here");
    },
    connectionsFor: async ({ userId: actor, toolkits }) =>
      (accounts.get(actor) ?? []).filter((row) =>
        toolkits.includes(row.toolkit),
      ),
    disconnect: async ({ userId: actor, connectionId }) => {
      const owned = accounts.get(actor) ?? [];
      if (!owned.some((row) => row.id === connectionId)) {
        throw new Error("connection does not belong to actor");
      }
      accounts.set(
        actor,
        owned.filter((row) => row.id !== connectionId),
      );
      disconnected.push(connectionId);
    },
    listTools: async () => [],
    callTool: async (input) => {
      calls.push({
        userId: input.userId,
        toolkit: input.toolkit,
        toolName: input.toolName,
      });
      return { text: "ok", isError: false, truncated: false };
    },
  },
});

let serverExisted = false;
let toolExisted = false;

beforeAll(async () => {
  const [server] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  serverExisted = server !== undefined;
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Drive",
      vendor: "Google",
      url: "https://backend.composio.dev",
      provenance: "first-party",
    })
    .onConflictDoNothing();

  const [tool] = await database
    .select({ name: mcpTools.name })
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  toolExisted = tool !== undefined;
  await database
    .insert(mcpTools)
    .values({ serverId, name: toolName, description: "Managed test tool" })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({
      id: botId,
      name: botId,
      type: "remote_ag_ui",
      configuration: {},
    })
    .onConflictDoNothing();
  await database
    .insert(users)
    .values({
      id: userId,
      email: `${userId}@openbot.test`,
      name: userId,
      emailVerified: false,
    })
    .onConflictDoNothing();
  await store.grant("mcp", ref, botId, "admin@openbot.test");
});

afterAll(async () => {
  await database
    .delete(pluginGrants)
    .where(and(eq(pluginGrants.ref, ref), eq(pluginGrants.agentId, botId)));
  if (!toolExisted) {
    await database
      .delete(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  }
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, userId));
  if (!serverExisted) {
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
});

describe("a managed connector call", () => {
  test("executes under the person asking and the reviewed toolkit", async () => {
    calls.length = 0;
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: userId }),
    ).resolves.toEqual({ text: "ok", isError: false });
    expect(calls).toEqual([{ userId, toolkit: "googledrive", toolName }]);
  });

  test("has no anonymous or deployment-wide credential fallback", async () => {
    calls.length = 0;
    await expect(
      store.callTool({ ref, args: {}, botId, actorId: "" }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(calls).toEqual([]);
  });
});

describe("managed connection lifecycle", () => {
  test("lists an opaque connection id without exposing credentials", async () => {
    await expect(store.connectionsFor(userId)).resolves.toEqual([
      {
        serverId,
        title: "Google Drive",
        vendor: "Google",
        connectionId: `conn_${suffix}`,
        scope: "Managed privately by Composio",
        connectedAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
  });

  test("offboarding deletes the private backend connection", async () => {
    disconnected.length = 0;
    await expect(
      store.retireConnectionsFor(userId, "admin@openbot.test"),
    ).resolves.toEqual({ retired: 1 });
    expect(disconnected).toEqual([`conn_${suffix}`]);
    expect(accounts.get(userId)).toEqual([]);
  });
});
