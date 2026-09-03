import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { mcpServers } from "../src/db/schema";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/** Managed entries must never reopen either of OpenBot's old OAuth storage paths. */
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const serverId = "google-drive";
let existed = false;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  managedConnector: {
    provider: "composio",
    listToolkits: async () => [
      {
        slug: "googledrive",
        name: "Google Drive",
        description: "Files in the Drive of whoever is asking.",
        logoUrl: null,
        categories: [],
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

beforeAll(async () => {
  const [row] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  existed = row !== undefined;
  await store.addServer({ key: serverId, by: "admin@openbot.test" });
});

afterAll(async () => {
  if (!existed) await store.removeServer(serverId, "admin@openbot.test");
});

describe("managed connector credential ownership", () => {
  test("refuses registering a deployment OAuth client", async () => {
    await expect(
      store.registerOAuthClient({
        serverId,
        client: { clientId: "client", clientSecret: "secret" },
        by: "admin@openbot.test",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  });

  test("refuses storing a user's refresh token", async () => {
    await expect(
      store.recordConnection({
        serverId,
        userId: "person-1",
        refreshToken: "refresh-token",
        scope: "scope",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  });
});
