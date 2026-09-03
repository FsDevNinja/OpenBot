import { describe, expect, test } from "bun:test";
import {
  type ComposioConnectorClient,
  composioEntityId,
  createComposioConnector,
  ManagedConnectorError,
  operationFromComposioTags,
} from "../src/plugins/managed-connector";

function fakeClient(overrides: Partial<ComposioConnectorClient> = {}) {
  const deleted: string[] = [];
  const executed: { slug: string; input: Record<string, unknown> }[] = [];
  const client: ComposioConnectorClient = {
    toolkits: {
      async get(query) {
        expect(query).toEqual({
          managedBy: "all",
          sortBy: "alphabetically",
          limit: 1_000,
        });
        return [
          {
            name: "Notion",
            slug: "notion",
            meta: {
              description: "Pages and databases.",
              logo: "https://cdn.example/notion.svg",
              toolsCount: 42,
              categories: [{ slug: "productivity", name: "Productivity" }],
            },
            isLocalToolkit: false,
            composioManagedAuthSchemes: ["OAUTH2"],
          },
          {
            name: "Bring your own OAuth app",
            slug: "project-managed",
            meta: {},
            isLocalToolkit: false,
            composioManagedAuthSchemes: [],
          },
          {
            name: "Local only",
            slug: "local-only",
            meta: {},
            isLocalToolkit: true,
            composioManagedAuthSchemes: ["OAUTH2"],
          },
        ];
      },
    },
    sessions: {
      async create(userId, config) {
        expect(userId).toBe(composioEntityId("acme-production", "user-1"));
        expect(config).toEqual({
          toolkits: ["notion"],
          manageConnections: false,
        });
        return {
          async authorize(toolkit, options) {
            expect(toolkit).toBe("notion");
            expect(options.callbackUrl).toBe("https://openbot.test/return");
            return {
              id: "conn-1",
              redirectUrl: "https://connect.composio.dev/link",
            };
          },
        };
      },
    },
    connectedAccounts: {
      async list(query) {
        expect(query.userIds).toEqual([
          composioEntityId("acme-production", "user-1"),
        ]);
        return {
          items: [
            {
              id: "conn-1",
              status: "ACTIVE",
              isDisabled: false,
              createdAt: "2026-09-02T12:00:00.000Z",
              toolkit: { slug: "notion" },
            },
            {
              id: "disabled",
              status: "ACTIVE",
              isDisabled: true,
              createdAt: "2026-09-02T12:00:00.000Z",
              toolkit: { slug: "notion" },
            },
          ],
        };
      },
      async delete(id) {
        deleted.push(id);
      },
    },
    tools: {
      async getRawComposioTools() {
        return [
          {
            slug: "NOTION_SEARCH",
            name: "Search",
            description: "Search this person's Notion workspace.",
            tags: ["readOnlyHint", "important"],
            inputParameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
            toolkit: { slug: "notion" },
          },
          {
            slug: "OTHER_TOOL",
            name: "Wrong toolkit",
            toolkit: { slug: "other" },
          },
        ];
      },
      async getRawComposioToolBySlug(slug) {
        return {
          slug,
          name: "Search",
          version: "20260902_00",
          toolkit: { slug: "notion" },
        };
      },
      async execute(slug, input) {
        executed.push({ slug, input });
        return { data: { pages: 2 }, error: null, successful: true };
      },
    },
    ...overrides,
  };
  return { client, deleted, executed };
}

describe("managed Composio connector", () => {
  test("lists only integrations whose OAuth applications Composio manages", async () => {
    const { client } = fakeClient();
    const connector = createComposioConnector({
      apiKey: "ak_test",
      deploymentNamespace: "acme-production",
      client,
    });

    await expect(connector.listToolkits()).resolves.toEqual([
      {
        slug: "notion",
        name: "Notion",
        description: "Pages and databases.",
        logoUrl: "https://cdn.example/notion.svg",
        categories: ["Productivity"],
        toolsCount: 42,
      },
    ]);
  });

  test("maps connector safety hints into fail-closed grant groups", () => {
    expect(operationFromComposioTags(["readOnlyHint"])).toBe("read");
    expect(operationFromComposioTags(["updateHint"])).toBe("write");
    expect(operationFromComposioTags([])).toBe("write");
    expect(operationFromComposioTags(["readOnlyHint", "destructiveHint"])).toBe(
      "delete",
    );
  });

  test("makes connector identities private and unique to a deployment", () => {
    const first = composioEntityId("acme-production", "user-1");

    expect(first).toBe(composioEntityId("acme-production", "user-1"));
    expect(first).not.toBe(composioEntityId("globex-production", "user-1"));
    expect(first).not.toBe(composioEntityId("acme-production", "user-2"));
    expect(first).not.toContain("user-1");
    expect(() => composioEntityId(" ", "user-1")).toThrow(
      "deployment namespace",
    );
    expect(() =>
      createComposioConnector({
        apiKey: "ak_test",
        deploymentNamespace: " ",
        client: fakeClient().client,
      }),
    ).toThrow("deployment namespace");
  });

  test("starts a private hosted consent flow without exposing an OAuth client", async () => {
    const { client } = fakeClient();
    const connector = createComposioConnector({
      apiKey: "ak_test",
      deploymentNamespace: "acme-production",
      client,
    });

    await expect(
      connector.beginConnection({
        userId: "user-1",
        toolkit: "notion",
        callbackUrl: "https://openbot.test/return",
      }),
    ).resolves.toEqual({
      connectionId: "conn-1",
      authorizationUrl: "https://connect.composio.dev/link",
    });
  });

  test("returns and deletes only active connections owned by that user and toolkit", async () => {
    const { client, deleted } = fakeClient();
    const connector = createComposioConnector({
      apiKey: "ak_test",
      deploymentNamespace: "acme-production",
      client,
    });

    await expect(
      connector.connectionsFor({ userId: "user-1", toolkits: ["notion"] }),
    ).resolves.toEqual([
      {
        id: "conn-1",
        toolkit: "notion",
        status: "ACTIVE",
        connectedAt: "2026-09-02T12:00:00.000Z",
      },
    ]);
    await connector.disconnect({
      userId: "user-1",
      toolkit: "notion",
      connectionId: "conn-1",
    });
    expect(deleted).toEqual(["conn-1"]);

    await expect(
      connector.disconnect({
        userId: "user-1",
        toolkit: "notion",
        connectionId: "somebody-elses",
      }),
    ).rejects.toBeInstanceOf(ManagedConnectorError);
    expect(deleted).toEqual(["conn-1"]);
  });

  test("maps the managed catalogue and pins the advertised tool version on execution", async () => {
    const { client, executed } = fakeClient();
    const connector = createComposioConnector({
      apiKey: "ak_test",
      deploymentNamespace: "acme-production",
      client,
    });

    await expect(connector.listTools("notion")).resolves.toEqual([
      {
        name: "NOTION_SEARCH",
        description: "Search this person's Notion workspace.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        operation: "read",
      },
    ]);
    await expect(
      connector.callTool({
        userId: "user-1",
        toolkit: "notion",
        toolName: "NOTION_SEARCH",
        args: { query: "roadmap" },
      }),
    ).resolves.toEqual({
      text: '{"pages":2}',
      isError: false,
      truncated: false,
    });
    expect(executed).toEqual([
      {
        slug: "NOTION_SEARCH",
        input: {
          userId: composioEntityId("acme-production", "user-1"),
          arguments: { query: "roadmap" },
          version: "20260902_00",
        },
      },
    ]);
  });

  test("refuses a tool outside the reviewed toolkit before execution", async () => {
    const { client, executed } = fakeClient({
      tools: {
        async getRawComposioTools() {
          return [];
        },
        async getRawComposioToolBySlug(slug) {
          return {
            slug,
            name: "Unexpected",
            version: "20260902_00",
            toolkit: { slug: "other" },
          };
        },
        async execute(slug, input) {
          executed.push({ slug, input });
          return { data: {}, error: null, successful: true };
        },
      },
    });
    const connector = createComposioConnector({
      apiKey: "ak_test",
      deploymentNamespace: "acme-production",
      client,
    });

    await expect(
      connector.callTool({
        userId: "user-1",
        toolkit: "notion",
        toolName: "OTHER_DELETE",
        args: {},
      }),
    ).rejects.toThrow("is not part of the notion toolkit");
    expect(executed).toEqual([]);
  });
});
