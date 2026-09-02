import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { EventType, RunAgentInputSchema } from "@ag-ui/client";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Observable } from "rxjs";
import type { AgentActor } from "../agents/profile-types";
import type { StallGuard } from "../channels/stall-guard";
import { COMPUTER_GUIDANCE } from "../../../shared/bot-prompt";
import type { DeploymentConfig } from "../config";
import type {
  HandoffForRun,
  IdentifyActor,
  LoadAgentsForActor,
  LoadToolsForBot,
  RuntimeModel,
  SignRun,
  ToolSelection,
} from "../agents/runtime-registry";
import { resolveRuntimeAgents } from "../agents/runtime-registry";
import type { AgentFetch } from "../channels/stall-guard";
import { type NativeThreadStore, ThreadAccessError } from "./thread-store";

const RENEW_EVERY_MS = 30_000;

class NativeRunError extends Error {
  constructor(
    message: string,
    readonly eventEmitted: boolean,
  ) {
    super(message);
    this.name = "NativeRunError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EventSink = (event: BaseEvent) => void | Promise<void>;

/** The in-process counterpart to the HTTP route, shared by routines and handoffs. */
export function mountNativeRuntime(
  config: DeploymentConfig,
  store: NativeThreadStore,
  model: RuntimeModel,
  loadAgents: LoadAgentsForActor,
  resolveModelApiKey: () => Promise<string | null>,
  identifyActor: IdentifyActor,
  stallGuard: StallGuard,
  loadToolsForActor?: (actorId: string) => LoadToolsForBot,
  signRunForActor?: (actorId: string) => SignRun,
  basePath = "/api/runtime",
  loadVendors?: () => Promise<readonly string[]>,
  selectionForActor?: (actorId: string) => ToolSelection,
  agentFetch?: AgentFetch,
  handoffForActor?: (actorId: string) => HandoffForRun,
  onRunBusy?: (input: { threadId: string; busy: boolean }) => void,
) {
  const buildFor = async (actor: AgentActor, botId: string) => {
    const agents = await resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      resolveModelApiKey,
      stallGuard,
      loadToolsForActor?.(actor.id),
      signRunForActor?.(actor.id),
      config.computer ? COMPUTER_GUIDANCE : undefined,
      loadVendors,
      selectionForActor?.(actor.id),
      agentFetch,
      handoffForActor?.(actor.id),
      botId,
    );
    return agents[botId] ?? null;
  };

  const runHeld = async (input: {
    agentId: string;
    threadId: string;
    runId: string;
    agent: Awaited<ReturnType<typeof buildFor>> extends infer T
      ? Exclude<T, null>
      : never;
    parameters: Partial<RunAgentInput>;
    persistedInputMessages?: readonly unknown[];
    onEvent?: EventSink;
  }) => {
    const before = new Set(input.agent.messages.map((message) => message.id));
    const destinationHistory = await store.historyForRun({
      threadId: input.threadId,
      runId: input.runId,
    });
    let terminalError: string | undefined;
    let persisted = false;

    try {
      const result = await input.agent.runAgent(
        {
          runId: input.runId,
          tools: input.parameters.tools ?? [],
          context: input.parameters.context ?? [],
          forwardedProps: input.parameters.forwardedProps,
          resume: input.parameters.resume,
        },
        {
          onEvent: async ({ event }) => {
            if (event.type === EventType.RUN_ERROR) {
              terminalError =
                "message" in event && typeof event.message === "string"
                  ? event.message
                  : "The Bot's run failed.";
            }
            await input.onEvent?.(event);
          },
        },
      );

      const output = result.newMessages.filter(
        (message) => !before.has(message.id),
      );
      const messages = input.persistedInputMessages
        ? [
            ...destinationHistory,
            ...(input.persistedInputMessages as Message[]),
            ...output,
          ]
        : [...input.agent.messages];
      await store.finish({
        threadId: input.threadId,
        runId: input.runId,
        messages,
        state: input.agent.state,
        ...(terminalError ? { error: terminalError } : {}),
      });
      persisted = true;
      if (terminalError) throw new NativeRunError(terminalError, true);
      return result;
    } catch (error) {
      if (!persisted) {
        await store.finish({
          threadId: input.threadId,
          runId: input.runId,
          messages: [...input.agent.messages],
          state: input.agent.state,
          error: errorMessage(error),
        });
      }
      throw error;
    }
  };

  const handler = new Hono();
  handler.get(`${basePath}/info`, (context) =>
    context.json({
      runtime: "openbot-native",
      protocol: "ag-ui",
      durableHistory: true,
    }),
  );
  handler.get(`${basePath}/threads/:threadId/messages`, async (context) => {
    const actor = await identifyActor(context.req.raw);
    const messages = await store.history({
      threadId: context.req.param("threadId"),
      actorId: actor.id,
    });
    return context.json({ messages });
  });
  handler.post(`${basePath}/agents/:agentId/run`, async (context) => {
    const actor = await identifyActor(context.req.raw);
    const parsed = RunAgentInputSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        { error: "A valid AG-UI run input is required." },
        400,
      );
    }
    const input = parsed.data;
    const agentId = context.req.param("agentId");
    const agent = await buildFor(actor, agentId);
    if (!agent)
      return context.json({ error: "That Bot is not available." }, 404);

    let held: { runId: string } | null;
    try {
      held = await store.acquire({
        threadId: input.threadId,
        runId: input.runId,
        userId: actor.id,
        agentId,
      });
    } catch (error) {
      if (error instanceof ThreadAccessError) {
        return context.json({ error: error.message }, 403);
      }
      throw error;
    }
    if (!held) {
      return context.json(
        { error: "That conversation is already running." },
        409,
      );
    }

    agent.threadId = input.threadId;
    agent.setMessages(input.messages);
    agent.setState(input.state ?? {});
    try {
      onRunBusy?.({ threadId: input.threadId, busy: true });
    } catch {}

    return streamSSE(context, async (stream) => {
      const heartbeat = setInterval(() => {
        void store
          .renew({ threadId: input.threadId, runId: input.runId })
          .catch(() => {
            agent.abortRun();
          });
      }, RENEW_EVERY_MS);
      heartbeat.unref?.();

      try {
        await runHeld({
          agentId,
          threadId: input.threadId,
          runId: input.runId,
          agent,
          parameters: input,
          onEvent: (event) => stream.writeSSE({ data: JSON.stringify(event) }),
        });
      } catch (error) {
        // A transport/model exception may happen before an agent can emit RUN_ERROR itself.
        if (!(error instanceof NativeRunError && error.eventEmitted)) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: EventType.RUN_ERROR,
              message: errorMessage(error),
              code: "NATIVE_RUNTIME_ERROR",
            }),
          });
        }
      } finally {
        clearInterval(heartbeat);
        try {
          onRunBusy?.({ threadId: input.threadId, busy: false });
        } catch {}
      }
    });
  });

  return {
    handler,
    agentFor: async (input: { actor: AgentActor; botId: string }) =>
      buildFor(input.actor, input.botId),
    history: (input: { threadId: string; actorId: string }) =>
      store.history(input),
    threadLock: {
      acquire: async (input: {
        threadId: string;
        runId: string;
        userId: string;
        agentId: string;
      }) => {
        const held = await store.acquire(input);
        if (held) {
          try {
            onRunBusy?.({ threadId: input.threadId, busy: true });
          } catch {}
        }
        return held;
      },
      renew: (input: { threadId: string; runId: string }) => store.renew(input),
      release: async (input: { threadId: string; runId: string }) => {
        try {
          onRunBusy?.({ threadId: input.threadId, busy: false });
        } catch {}
        await store.release(input);
      },
    },
    runner: {
      run(request: {
        threadId: string;
        agent: NonNullable<Awaited<ReturnType<typeof buildFor>>>;
        input: RunAgentInput;
        persistedInputMessages?: readonly unknown[];
      }) {
        return new Observable<BaseEvent>((subscriber) => {
          void runHeld({
            agentId: request.agent.agentId ?? "",
            threadId: request.threadId,
            runId: request.input.runId,
            agent: request.agent,
            parameters: request.input,
            persistedInputMessages: request.persistedInputMessages,
            onEvent: (event) => subscriber.next(event),
          }).then(
            () => subscriber.complete(),
            (error) => subscriber.error(error),
          );
          return () => request.agent.abortRun();
        });
      },
    },
  };
}
