import { createHash } from "node:crypto";
import { Composio } from "@composio/core";
import {
  MAX_RESULT_CHARS,
  type McpCallResult,
  type McpTool,
  type ToolOperation,
} from "./mcp";

/**
 * The boundary between OpenBot and a service that owns connector authentication.
 *
 * OpenBot deliberately sees connection ids and status, never OAuth clients, access tokens or
 * refresh tokens. The backend creates private, per-user connections and executes tools against the
 * connection belonging to the same stable OpenBot user id.
 */
export type ManagedConnection = {
  id: string;
  toolkit: string;
  status: string;
  connectedAt: string;
};

/** One connector family whose OAuth application Composio owns for this project. */
export type ManagedToolkit = {
  slug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  categories: string[];
  toolsCount: number | null;
};

export type ManagedConnector = {
  readonly provider: "composio";
  listToolkits(): Promise<ManagedToolkit[]>;
  beginConnection(input: {
    userId: string;
    toolkit: string;
    callbackUrl: string;
  }): Promise<{ connectionId: string; authorizationUrl: string }>;
  connectionsFor(input: {
    userId: string;
    toolkits: readonly string[];
  }): Promise<ManagedConnection[]>;
  disconnect(input: {
    userId: string;
    toolkit: string;
    connectionId: string;
  }): Promise<void>;
  listTools(toolkit: string): Promise<McpTool[]>;
  callTool(input: {
    userId: string;
    toolkit: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<McpCallResult>;
};

export class ManagedConnectorError extends Error {}

/**
 * The identity Composio sees is scoped to one OpenBot deployment and contains no email or database
 * id. That makes the same person in two customer deployments two different connector users, while
 * still being deterministic enough for every connect, list and execute call to find the same
 * account.
 */
export function composioEntityId(
  deploymentNamespace: string,
  userId: string,
): string {
  const namespace = deploymentNamespace.trim();
  const user = userId.trim();
  if (!namespace) {
    throw new ManagedConnectorError(
      "A deployment namespace is required for managed connectors.",
    );
  }
  if (!user) {
    throw new ManagedConnectorError(
      "A user id is required for managed connectors.",
    );
  }

  const digest = (value: string, length: number) =>
    createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
  return `openbot_${digest(namespace, 16)}_${digest(user, 24)}`;
}

type ComposioTool = {
  slug: string;
  name: string;
  description?: string;
  inputParameters?: Record<string, unknown>;
  /** Composio's MCP safety hints, alongside topical tags. */
  tags?: string[];
  version?: string;
  toolkit?: { slug: string };
};

/**
 * Turn Composio's MCP safety hints into the three grant groups an administrator reviews.
 *
 * Destructive wins if a provider ever sends contradictory hints. Missing or unfamiliar metadata
 * is a write, never a read: the convenient failure mode is additional scrutiny, not silently
 * including an unknown operation in a read-only bulk grant.
 */
export function operationFromComposioTags(
  tags: readonly string[] = [],
): ToolOperation {
  const hints = new Set(tags.map((tag) => tag.toLowerCase()));
  if (hints.has("destructivehint")) return "delete";
  if (hints.has("readonlyhint")) return "read";
  return "write";
}

type ComposioAccount = {
  id: string;
  status: string;
  isDisabled: boolean;
  createdAt: string;
  toolkit: { slug: string };
};

type ComposioToolkit = {
  name: string;
  slug: string;
  meta: {
    categories?: { slug: string; name: string }[];
    description?: string;
    logo?: string;
    toolsCount?: number;
  };
  isLocalToolkit: boolean;
  composioManagedAuthSchemes?: string[];
};

/** The deliberately small SDK surface this adapter depends on, and a seam for its unit tests. */
export type ComposioConnectorClient = {
  toolkits: {
    get(query: {
      managedBy: "all";
      sortBy: "alphabetically";
      limit: number;
    }): Promise<ComposioToolkit[]>;
  };
  sessions: {
    create(
      userId: string,
      config: { toolkits: string[]; manageConnections: boolean },
    ): Promise<{
      authorize(
        toolkit: string,
        options: { callbackUrl: string },
      ): Promise<{ id: string; redirectUrl?: string | null }>;
    }>;
  };
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      statuses?: string[];
      limit?: number;
    }): Promise<{ items: ComposioAccount[] }>;
    delete(connectionId: string): Promise<unknown>;
  };
  tools: {
    getRawComposioTools(query: {
      toolkits: string[];
      limit: number;
      important: false;
    }): Promise<ComposioTool[]>;
    getRawComposioToolBySlug(slug: string): Promise<ComposioTool>;
    execute(
      slug: string,
      input: {
        userId: string;
        arguments: Record<string, unknown>;
        version: string;
      },
    ): Promise<{
      data: Record<string, unknown>;
      error: string | null;
      successful: boolean;
    }>;
  };
};

function failure(error: unknown, action: string): ManagedConnectorError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ManagedConnectorError(
    `${action} through Composio failed${detail ? `: ${detail}` : "."}`,
  );
}

/**
 * Composio owns the provider catalogue, OAuth applications, token exchange, storage and refresh.
 * The API key identifies this OpenBot deployment to Composio; it is not a user's provider token.
 */
export function createComposioConnector(input: {
  apiKey: string;
  deploymentNamespace: string;
  client?: ComposioConnectorClient;
}): ManagedConnector {
  const deploymentNamespace = input.deploymentNamespace.trim();
  if (!deploymentNamespace) {
    throw new ManagedConnectorError(
      "A deployment namespace is required for managed connectors.",
    );
  }
  const client =
    input.client ??
    (new Composio({
      apiKey: input.apiKey,
      allowTracking: false,
    }) as unknown as ComposioConnectorClient);

  return {
    provider: "composio",

    async listToolkits() {
      try {
        const toolkits = await client.toolkits.get({
          // Fetch all, then keep only the integrations whose OAuth app Composio owns. A project-
          // managed auth scheme would put OAuth provisioning back into OpenBot, which is precisely
          // what this boundary exists to avoid.
          managedBy: "all",
          sortBy: "alphabetically",
          limit: 1_000,
        });
        return toolkits
          .filter(
            (toolkit) =>
              !toolkit.isLocalToolkit &&
              (toolkit.composioManagedAuthSchemes?.length ?? 0) > 0 &&
              /^[a-z0-9][a-z0-9_-]{0,119}$/.test(toolkit.slug),
          )
          .map((toolkit) => ({
            slug: toolkit.slug,
            name: toolkit.name,
            description:
              toolkit.meta.description ??
              `Use ${toolkit.name} through your own connected account.`,
            logoUrl: toolkit.meta.logo ?? null,
            categories: (toolkit.meta.categories ?? []).map(
              (category) => category.name,
            ),
            toolsCount: toolkit.meta.toolsCount ?? null,
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        throw failure(error, "Reading the integration catalogue");
      }
    },

    async beginConnection({ userId, toolkit, callbackUrl }) {
      try {
        const session = await client.sessions.create(
          composioEntityId(deploymentNamespace, userId),
          {
            toolkits: [toolkit],
            // OpenBot renders its own connection controls; the hosted page only performs consent.
            manageConnections: false,
          },
        );
        const request = await session.authorize(toolkit, { callbackUrl });
        if (!request.redirectUrl) {
          throw new Error("the provider returned no authorization URL");
        }
        return {
          connectionId: request.id,
          authorizationUrl: request.redirectUrl,
        };
      } catch (error) {
        throw failure(error, `Connecting ${toolkit}`);
      }
    },

    async connectionsFor({ userId, toolkits }) {
      if (toolkits.length === 0) return [];
      try {
        const response = await client.connectedAccounts.list({
          userIds: [composioEntityId(deploymentNamespace, userId)],
          toolkitSlugs: [...toolkits],
          statuses: ["ACTIVE"],
          limit: 100,
        });
        return response.items
          .filter(
            (account) =>
              account.status === "ACTIVE" &&
              !account.isDisabled &&
              toolkits.includes(account.toolkit.slug),
          )
          .map((account) => ({
            id: account.id,
            toolkit: account.toolkit.slug,
            status: account.status,
            connectedAt: account.createdAt,
          }));
      } catch (error) {
        throw failure(error, "Reading connected accounts");
      }
    },

    async disconnect({ userId, toolkit, connectionId }) {
      const accounts = await this.connectionsFor({
        userId,
        toolkits: [toolkit],
      });
      if (!accounts.some((account) => account.id === connectionId)) {
        throw new ManagedConnectorError(
          "That connection does not belong to this person and connector.",
        );
      }
      try {
        await client.connectedAccounts.delete(connectionId);
      } catch (error) {
        throw failure(error, `Disconnecting ${toolkit}`);
      }
    },

    async listTools(toolkit) {
      try {
        const tools = await client.tools.getRawComposioTools({
          toolkits: [toolkit],
          // Explicitly request the full toolkit rather than Composio's smaller "important" set.
          limit: 1_000,
          important: false,
        });
        return tools
          .filter((tool) => tool.toolkit?.slug === toolkit)
          .map((tool) => ({
            name: tool.slug,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputParameters ?? {
              type: "object",
              properties: {},
            },
            operation: operationFromComposioTags(tool.tags),
          }));
      } catch (error) {
        throw failure(error, `Listing ${toolkit} tools`);
      }
    },

    async callTool({ userId, toolkit, toolName, args }) {
      try {
        const tool = await client.tools.getRawComposioToolBySlug(toolName);
        if (tool.toolkit?.slug !== toolkit) {
          throw new Error(`${toolName} is not part of the ${toolkit} toolkit`);
        }
        if (!tool.version || tool.version === "latest") {
          throw new Error(`${toolName} has no pinned executable version`);
        }
        const result = await client.tools.execute(toolName, {
          userId: composioEntityId(deploymentNamespace, userId),
          arguments: args,
          version: tool.version,
        });
        const fullText = result.successful
          ? JSON.stringify(result.data)
          : result.error || "The connector reported an error.";
        const truncated = fullText.length > MAX_RESULT_CHARS;
        return {
          text: truncated
            ? `${fullText.slice(0, MAX_RESULT_CHARS)}\n\n[Result truncated by OpenBot]`
            : fullText,
          isError: !result.successful,
          truncated,
        };
      } catch (error) {
        throw failure(error, `Calling ${toolName}`);
      }
    },
  };
}
