import type { ActivityMessage, Message, ToolCall } from "@ag-ui/core";
import { HttpAgent, type AbstractAgent } from "@ag-ui/client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

type ToolRenderProps = {
  // Tool registrations are generic over their Zod schema. The registry erases that generic and
  // restores the exact value at the hook boundary, the same job an event bus does for payloads.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool schemas share this registry.
  args?: any;
  // biome-ignore lint/suspicious/noExplicitAny: see args.
  parameters?: any;
  // biome-ignore lint/suspicious/noExplicitAny: render-only registrations accept decoded values too.
  result?: any;
  status: "executing" | "complete";
  toolCall?: ToolCall;
  toolCallId?: string;
  respond?: (result: unknown) => Promise<void>;
};

type ToolSpec = {
  name: string;
  description?: string;
  parameters?: unknown;
  available?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: validated by the registration's own schema.
  handler?: (args: any, context: any) => unknown | Promise<unknown>;
  render?: (props: ToolRenderProps) => ReactNode;
  human?: boolean;
};

type Registered = { current: ToolSpec };

type RuntimeRegistry = {
  revision: number;
  register: (name: string, registration: Registered) => () => void;
  registrations: Map<string, Registered>;
  pending: Map<string, (result: unknown) => void>;
  notify: () => void;
};

const RuntimeContext = createContext<RuntimeRegistry | null>(null);

export enum UseAgentUpdate {
  OnMessagesChanged = "messages",
  OnRunStatusChanged = "run-status",
}

function useRuntime(): RuntimeRegistry {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("RuntimeProvider is missing.");
  return runtime;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const registrations = useRef(new Map<string, Registered>()).current;
  const pending = useRef(new Map<string, (result: unknown) => void>()).current;
  const [revision, setRevision] = useState(0);
  const notify = useCallback(() => setRevision((value) => value + 1), []);
  const register = useCallback(
    (name: string, registration: Registered) => {
      registrations.set(name, registration);
      setRevision((value) => value + 1);
      return () => {
        if (registrations.get(name) === registration) {
          registrations.delete(name);
          setRevision((value) => value + 1);
        }
      };
    },
    [registrations],
  );

  const runtime = useMemo<RuntimeRegistry>(
    () => ({
      revision,
      registrations,
      pending,
      notify,
      register,
    }),
    [notify, pending, register, registrations, revision],
  );

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

function useRegistration(spec: ToolSpec): void {
  const runtime = useRuntime();
  const reference = useRef<Registered>({ current: spec });
  reference.current.current = spec;

  useEffect(
    () => runtime.register(spec.name, reference.current),
    [runtime.register, spec.name],
  );
}

export function useFrontendTool(spec: ToolSpec): void {
  useRegistration(spec);
}

export function useRenderTool(spec: ToolSpec): void {
  useRegistration(spec);
}

export function useHumanInTheLoop(spec: ToolSpec): void {
  useRegistration({ ...spec, human: true });
}

function schemaOf(parameters: unknown): Record<string, unknown> {
  try {
    if (parameters instanceof z.ZodType) {
      return z.toJSONSchema(parameters) as Record<string, unknown>;
    }
  } catch {}
  return parameters && typeof parameters === "object"
    ? (parameters as Record<string, unknown>)
    : { type: "object", properties: {} };
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "Done.";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function unresolvedCalls(messages: Message[]): ToolCall[] {
  const answered = new Set(
    messages.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    ),
  );
  const lastAssistant = [...messages]
    .reverse()
    .find(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
  return lastAssistant?.role === "assistant"
    ? (lastAssistant.toolCalls ?? []).filter((call) => !answered.has(call.id))
    : [];
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const controllers = new WeakMap<AbstractAgent, AbortController>();

async function runWithTools(
  runtime: RuntimeRegistry,
  agent: AbstractAgent,
): Promise<void> {
  const controller = new AbortController();
  controllers.set(agent, controller);
  try {
    // Each browser tool result is a new AG-UI run. Server-side tools stay inside one server run.
    for (let pass = 0; pass < 16; pass += 1) {
      const tools = [...runtime.registrations.values()]
        .map((registration) => registration.current)
        .filter(
          (spec) => spec.available !== false && (spec.handler || spec.human),
        )
        .map((spec) => ({
          name: spec.name,
          description: spec.description ?? spec.name,
          parameters: schemaOf(spec.parameters),
        }));

      await agent.runAgent({ tools, abortController: controller } as never);
      if (controller.signal.aborted) return;

      const calls = unresolvedCalls(agent.messages as Message[]).filter(
        (call) => {
          const spec = runtime.registrations.get(call.function.name)?.current;
          return Boolean(
            spec && spec.available !== false && (spec.handler || spec.human),
          );
        },
      );
      if (calls.length === 0) return;

      for (const call of calls) {
        const spec = runtime.registrations.get(call.function.name)?.current;
        if (!spec) continue;
        let result: unknown;
        if (spec.human) {
          result = await new Promise((resolve) => {
            runtime.pending.set(call.id, resolve);
            runtime.notify();
          });
          runtime.pending.delete(call.id);
          runtime.notify();
        } else {
          result = await spec.handler?.(parseArguments(call) as never, {
            signal: controller.signal,
            toolCall: { id: call.id },
          });
        }
        agent.addMessage({
          id: crypto.randomUUID(),
          role: "tool",
          toolCallId: call.id,
          content: resultText(result),
        });
      }
    }
    throw new Error("The browser tool loop exceeded 16 passes.");
  } finally {
    controllers.delete(agent);
  }
}

export function useAgent(options: {
  agentId: string;
  runtimeAgentId?: string;
  threadId?: string;
  updates?: UseAgentUpdate[];
}) {
  const runtimeId = options.runtimeAgentId ?? options.agentId;
  const agent = useMemo(() => {
    const next = new HttpAgent({
      url: `/api/runtime/agents/${encodeURIComponent(runtimeId)}/run`,
      agentId: runtimeId,
    });
    if (options.threadId) next.threadId = options.threadId;
    return next;
  }, [options.threadId, runtimeId]);
  const [, redraw] = useState(0);

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: () => redraw((value) => value + 1),
      onRunInitialized: () => redraw((value) => value + 1),
      onRunFinalized: () => redraw((value) => value + 1),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  return { agent, isReady: true };
}

export function useOpenBotRuntime() {
  const runtime = useRuntime();
  const { notify, pending, register, registrations } = runtime;
  const stable = useMemo(
    () => ({
      revision: 0,
      notify,
      pending,
      register,
      registrations,
    }),
    [notify, pending, register, registrations],
  );
  return useMemo(
    () => ({
      runtime: {
        runAgent: ({ agent }: { agent: AbstractAgent }) =>
          runWithTools(stable, agent),
        stopAgent: ({ agent }: { agent: AbstractAgent }) => {
          controllers.get(agent)?.abort();
          agent.abortRun();
        },
        connectAgent: () => Promise.resolve(),
      },
    }),
    [stable],
  );
}

export function useRenderToolCall() {
  const runtime = useRuntime();
  return ({
    toolCall,
    toolMessage,
  }: {
    toolCall: ToolCall;
    toolMessage?: Extract<Message, { role: "tool" }>;
  }): ReactNode => {
    const spec = runtime.registrations.get(toolCall.function.name)?.current;
    if (!spec?.render) return null;
    const args = parseArguments(toolCall);
    const result =
      typeof toolMessage?.content === "string"
        ? toolMessage.content
        : undefined;
    const pending = runtime.pending.get(toolCall.id);
    return spec.render({
      args,
      parameters: args,
      result,
      status: result === undefined ? "executing" : "complete",
      toolCall,
      toolCallId: toolCall.id,
      ...(pending
        ? {
            respond: async (value: unknown) => {
              pending(value);
            },
          }
        : {}),
    });
  };
}

export function OpenGenerativeUIActivityRenderer({
  content,
}: {
  content: unknown;
  [key: string]: unknown;
}) {
  const value = (content ?? {}) as {
    html?: string | string[];
    css?: string;
    jsFunctions?: string;
  };
  const html = Array.isArray(value.html)
    ? value.html.join("")
    : (value.html ?? "");
  const source = `<!doctype html><html><head><meta charset="utf-8"><style>${value.css ?? ""}</style></head><body>${html}<script>${value.jsFunctions ?? ""}</script></body></html>`;
  return (
    <iframe
      className="min-h-48 w-full rounded-xl border bg-background"
      sandbox="allow-scripts"
      srcDoc={source}
      title="Generated interface"
    />
  );
}

export function useRenderActivityMessage() {
  return {
    renderActivityMessage(message: ActivityMessage): ReactNode {
      if (message.activityType !== "open-generative-ui") return null;
      return <OpenGenerativeUIActivityRenderer content={message.content} />;
    },
  };
}
