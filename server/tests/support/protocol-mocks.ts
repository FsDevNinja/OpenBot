import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type AGUIInput = {
  threadId?: string;
  runId?: string;
  messages?: { role?: string; content?: unknown }[];
  [key: string]: unknown;
};

type AGUIEvent = { type: string; [key: string]: unknown };

function lastUserText(input: AGUIInput): string {
  const message = [...(input.messages ?? [])]
    .reverse()
    .find((candidate) => candidate.role === "user");
  return typeof message?.content === "string" ? message.content : "";
}

/** A deliberately small AG-UI endpoint used by protocol and integration tests. */
export class AGUIMock {
  private fixtures: {
    matches: (input: AGUIInput) => boolean;
    events: AGUIEvent[];
  }[] = [];
  private server?: ReturnType<typeof Bun.serve>;

  onRun(pattern: string | RegExp, events: AGUIEvent[]): this {
    this.fixtures.push({
      matches: (input) => {
        const text = lastUserText(input);
        if (typeof pattern === "string") return text.includes(pattern);
        pattern.lastIndex = 0;
        return pattern.test(text);
      },
      events,
    });
    return this;
  }

  onPredicate(
    predicate: (input: AGUIInput) => boolean,
    events: AGUIEvent[],
  ): this {
    this.fixtures.push({ matches: predicate, events });
    return this;
  }

  async start(): Promise<string> {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST")
          return new Response("Not found", { status: 404 });
        const input = (await request.json()) as AGUIInput;
        const fixture = this.fixtures.find((candidate) =>
          candidate.matches(input),
        );
        if (!fixture)
          return new Response("No matching AG-UI fixture", { status: 404 });
        const body = fixture.events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      },
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = undefined;
  }
}

export function buildAGUITextResponse(text: string): AGUIEvent[] {
  const threadId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId, runId },
  ];
}

type ModelFixture = {
  pattern: string | RegExp;
  response: { type: "text"; content: string };
};

/** An OpenAI-compatible chat-completions endpoint for deterministic model tests. */
export class LLMock {
  private fixtures: ModelFixture[] = [];
  private requests: { body: unknown }[] = [];
  private server?: ReturnType<typeof Bun.serve>;

  onMessage(
    pattern: string | RegExp,
    response: { type: "text"; content: string },
  ): this {
    this.fixtures.push({ pattern, response });
    return this;
  }

  clearFixtures(): void {
    this.fixtures = [];
  }

  clearRequests(): void {
    this.requests = [];
  }

  getRequests(): { body: unknown }[] {
    return [...this.requests];
  }

  async start(): Promise<string> {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (
          request.method !== "POST" ||
          !new URL(request.url).pathname.endsWith("/chat/completions")
        ) {
          return new Response("Not found", { status: 404 });
        }
        const body = (await request.json()) as {
          stream?: boolean;
          model?: string;
          messages?: { role?: string; content?: unknown }[];
        };
        this.requests.push({ body });
        const text =
          [...(body.messages ?? [])]
            .reverse()
            .map((message) =>
              typeof message.content === "string" ? message.content : "",
            )
            .find(Boolean) ?? "";
        const fixture = this.fixtures.find(({ pattern }) => {
          if (typeof pattern === "string") return text.includes(pattern);
          pattern.lastIndex = 0;
          return pattern.test(text);
        });
        if (!fixture)
          return new Response("No matching model fixture", { status: 404 });

        const id = `chatcmpl-${randomUUID()}`;
        const model = body.model ?? "mock-model";
        if (body.stream) {
          const chunks = [
            {
              id,
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: fixture.response.content,
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id,
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ];
          return new Response(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        }

        return Response.json({
          id,
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: fixture.response.content },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = undefined;
  }
}

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** A real MCP SDK server with a fixture-friendly registration surface. */
export class MCPMock {
  private tools = new Map<string, ToolDefinition>();
  private handlers = new Map<
    string,
    (args: unknown) => ToolContent[] | string | Promise<ToolContent[] | string>
  >();
  private requests: unknown[] = [];
  private bunServer?: ReturnType<typeof Bun.serve>;
  private protocolServers = new Set<Server>();
  private port?: number;

  constructor(options: { port?: number } = {}) {
    this.port = options.port;
  }

  addTool(definition: ToolDefinition): this {
    this.tools.set(definition.name, definition);
    return this;
  }

  onToolCall(
    name: string,
    handler: (
      args: unknown,
    ) => ToolContent[] | string | Promise<ToolContent[] | string>,
  ): this {
    this.handlers.set(name, handler);
    return this;
  }

  getRequests(): unknown[] {
    return [...this.requests];
  }

  async start(): Promise<string> {
    this.bunServer = Bun.serve({
      port: this.port ?? 0,
      fetch: async (request) => {
        // The SDK deliberately requires a fresh stateless transport per HTTP request. A matching
        // Server is cheap here and also keeps one test client's request ids isolated from another's.
        const server = new Server(
          { name: "openbot-protocol-mock", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async (message) => {
          this.requests.push(message);
          return {
            tools: [...this.tools.values()].map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema ?? {
                type: "object",
                properties: {},
              },
            })),
          };
        });
        server.setRequestHandler(CallToolRequestSchema, async (message) => {
          this.requests.push(message);
          const handler = this.handlers.get(message.params.name);
          if (!handler) throw new Error(`Unknown tool: ${message.params.name}`);
          try {
            const result = await handler(message.params.arguments ?? {});
            return {
              content:
                typeof result === "string"
                  ? [{ type: "text" as const, text: result }]
                  : result,
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
            };
          }
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        this.protocolServers.add(server);
        return transport.handleRequest(request);
      },
    });
    return `http://127.0.0.1:${this.bunServer.port}`;
  }

  async stop(): Promise<void> {
    this.bunServer?.stop(true);
    this.bunServer = undefined;
    await Promise.all(
      [...this.protocolServers].map((server) => server.close()),
    );
    this.protocolServers.clear();
  }
}
