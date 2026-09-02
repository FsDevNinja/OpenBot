/**
 * One headless turn into the same native thread a person opens in a channel.
 *
 * Routines drive the in-process AG-UI runner directly so completion, reply text, and failures are
 * observable. PostgreSQL owns both transcript durability and the cross-replica lease. The lock is
 * acquired here because a routine has no browser request for the HTTP runtime to acquire it around.
 */
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
  ToolCall,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import type { TurnRunner } from "./runner";

/**
 * The gap between stopping a turn and giving up on it.
 *
 * `abortRun` on `RunSelectedAgent` reaches the agent the run turned into, and that agent does not
 * exist until `build()` resolves (`agents/runtime-registry.ts`): during that window the wrapper has no
 * `inner`, so abort is a no-op and the deadline cannot actually stop anything. This is the backstop
 * that settles the promise anyway, so a firing cannot hang for ever on a build that never finishes.
 *
 * Injectable only so the test can exercise the backstop without waiting five real seconds for it.
 */
const DEFAULT_ABORT_GRACE_MS = 5_000;

/** How long one headless turn may take before it is stopped. */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * The lock TTL and how often it is renewed.
 *
 * Renew comfortably inside the TTL so one slow request does not drop a lock we still hold.
 */
const DEFAULT_LOCK_TTL_SECONDS = 20;
const DEFAULT_HEARTBEAT_MS = 15_000;

/** The native thread operations a headless turn needs. */
export type ThreadRuntime = {
  ensure(params: {
    threadId: string;
    userId: string;
    agentId: string;
  }): Promise<void>;
  history(params: { threadId: string; userId: string }): Promise<Message[]>;
  acquire(params: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    ttlSeconds?: number;
  }): Promise<unknown>;
  renew(params: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }): Promise<unknown>;
  release(params: { threadId: string; runId: string }): Promise<void>;
};

/**
 * What we subscribe to. Declared rather than imported as `Observable<BaseEvent>` so a fake is a plain
 * object; the real observable satisfies it.
 */
type EventStream = {
  subscribe(observer: {
    next: (event: BaseEvent) => void;
    error: (error: unknown) => void;
    complete: () => void;
  }): unknown;
};

/** The in-process AG-UI runner, named by the two methods this file calls. */
export type RunnerLike = {
  run(request: {
    threadId: string;
    agent: AbstractAgent;
    input: RunAgentInput;
    persistedInputMessages?: Message[];
  }): EventStream;
  stop(request: {
    threadId: string;
    runId?: string;
  }): Promise<boolean | undefined>;
};

/** Whether a message said nothing at all — no text, no parts, nothing to show a person. */
function isSilent(message: Message): boolean {
  const content = (message as { content?: unknown }).content;
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

/**
 * Refuse to re-present a conversation the model API will reject.
 *
 * FOUND IN PRODUCTION. Two firings of one routine, fifteen minutes apart, both failed with
 * `Tool result is missing for tool call call_TTbiXzJVNifQt8ioU1JJmj4S.` — the SAME call id both
 * times, so it did not come from the live turn: the channel's stored thread held an assistant
 * message carrying a tool call whose result message never landed, because an earlier CHAT turn was
 * interrupted mid-call. The seeding below hands the whole converted history to the runner, the model
 * provider validates call/result pairing, and it rejects the conversation. One historical dangle
 * therefore poisons EVERY future firing in that channel until the fatigue rule disables the routine:
 * a permanent failure grown out of transient damage, and nothing the person did wrong.
 *
 * WHY DROPPING IS THE RIGHT ANSWER, and not repair. History here is CONTEXT for a turn, not a
 * transaction to resume. A dangling call is already permanently unanswerable — the tool run that
 * would have answered it ended when that chat turn did, and there is no result to invent. The only
 * two options are to seed a conversation the API refuses, or to seed the same conversation minus a
 * call that never completed. The second one loses a fragment of an interrupted exchange; the first
 * one disables a routine forever.
 *
 * WHAT THIS DOES NOT DO. It does not DELETE anything from the platform. The thread still holds every
 * row, the person still sees the interrupted exchange in their channel, and a browser turn is
 * unaffected. This is a read-side filter on one turn's input and nothing more.
 *
 * IDS ARE NEVER CHANGED, which is what keeps `persistedInputMessages`' id-subtraction below correct:
 * a message this pass stripped a tool call from keeps its id and is still subtracted out as historic,
 * and a message it dropped was never a candidate to persist. So sanitizing cannot turn a firing into
 * one that re-persists the transcript.
 *
 * The rules, in order:
 *  1. A tool call is ANSWERED if some later message carries it as `toolCallId`. Later, not merely
 *     present: a result ahead of its call is not a pairing any provider accepts either.
 *  2. An assistant message keeps only its answered calls. If that leaves it with no calls and
 *     nothing said, the message is dropped — an empty assistant husk is itself invalid for some
 *     providers, so stripping the call is not enough.
 *  3. A tool result whose `toolCallId` matches no surviving call is dropped: the mirror-image dangle,
 *     which is what an interruption between the two rows leaves behind in the other order.
 *
 * Order is preserved, the input array is not mutated, and a message the pass does not change is
 * returned as the same object — a healthy thread, which is nearly all of them, goes through
 * untouched rather than through a re-normalization that could quietly differ.
 */
export function sanitizeSeededHistory(history: Message[]): Message[] {
  /** For each answered call id, the earliest position that answers it. */
  const answeredAt = new Map<string, number>();
  for (const [index, message] of history.entries()) {
    const { toolCallId } = message as { toolCallId?: string };
    if (toolCallId === undefined) continue;
    if (!answeredAt.has(toolCallId)) answeredAt.set(toolCallId, index);
  }

  const surviving = new Set<string>();
  const kept: (Message | undefined)[] = history.map((message, index) => {
    const { toolCalls } = message as { toolCalls?: ToolCall[] };
    if (toolCalls === undefined) return message;

    const answered = toolCalls.filter((call) => {
      const at = answeredAt.get(call.id);
      return at !== undefined && at > index;
    });
    for (const call of answered) surviving.add(call.id);

    // The husk check goes FIRST so it also catches a row that arrived with no calls and nothing
    // said — the same invalid shape, reached without a dangle.
    if (answered.length === 0 && isSilent(message)) return undefined;
    // The healthy path, and the only one that returns the very same object.
    if (answered.length === toolCalls.length) return message;

    /*
     * Cast for the same reason `toAgentMessage` casts: `Message` is a union discriminated on `role`,
     * and a spread over the union widens past every branch of it. Neither rewrite here can change
     * the role or the shape — one narrows the `toolCalls` array, the other removes the key — so
     * there is nothing to narrow against and nothing that could stop being a `Message`.
     */
    if (answered.length > 0) {
      return { ...message, toolCalls: answered } as Message;
    }
    // Text it did say, minus a call it cannot complete.
    const { toolCalls: _dropped, ...rest } = message as Message & {
      toolCalls?: ToolCall[];
    };
    return rest as Message;
  });

  return kept.filter((message): message is Message => {
    if (message === undefined) return false;
    const { toolCallId } = message as { toolCallId?: string };
    return toolCallId === undefined || surviving.has(toolCallId);
  });
}

/** What a message said out loud, or nothing if it did not say anything. */
function assistantText(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  const { content } = message;
  return typeof content === "string" && content.length > 0
    ? content
    : undefined;
}

/**
 * The stored instruction, wrapped in the sentences that tell the turn it IS a firing.
 *
 * FOUND ON A LIVE FIRING, and it recorded `succeeded`. The instruction read "Every run, append the
 * current date and time as a new bulleted list item to the Notion page …" and was sent to the model
 * verbatim as the turn's user message. The model read it as a question about routine MANAGEMENT
 * rather than as work: it called `list_routines`, found a routine that already said exactly that,
 * answered that it was already configured, and appended nothing. Nothing failed, so nothing was
 * reported — a routine telling somebody it is working while doing nothing at all, which is worse than
 * one that breaks.
 *
 * And the model was not being stupid. Instructions are WRITTEN in schedule-speak — "every run",
 * "every 15 minutes", "each morning" — because that is how a person asks for a standing thing, and
 * schedule-shaped prose arriving out of nowhere reads as a request to SET UP a schedule. The most
 * plausible reading of its own routine's text was "check whether this is set up"; it was, so it did
 * nothing, successfully. No wording of the stored instruction fixes that on its own, because the
 * sentence a person writes is the sentence that describes the schedule.
 *
 * So the frame says the three things the instruction cannot say about itself: that this is a
 * scheduled firing happening now, that the work belongs in this turn, and that managing routines is
 * not what was asked. It is PRESENTATION — which is why it lives here and not in the stored row or in
 * {@link TurnRunner}'s signature: the row keeps what the person asked for, and this is how it is put
 * to the model.
 *
 * ONLY THE NEW MESSAGE IS FRAMED, and that matters twice. The framed text is what
 * `persistedInputMessages` writes to the transcript — correctly, since the transcript should show
 * what the turn was actually asked — so it comes back as HISTORY on the next firing. History is
 * converted and seeded exactly as the platform handed it over and nothing re-frames it; a test holds
 * that, because the alternative is a message that grows a fresh paragraph of frame every night.
 */
export function frameFiring(instruction: string): string {
  return [
    "One of your routines is firing right now, on its schedule, and this is that firing.",
    "Carry out the instruction below in this turn: do the work now, then say what happened.",
    "Do not create, list or change any routine unless the instruction itself asks you to.",
    "",
    instruction,
  ].join("\n");
}

export function createTurnRunner(options: {
  threads: ThreadRuntime;
  runner: RunnerLike;
  /** The owner's coworkers, resolved as the owner. Built per turn, keyed by registry id. */
  buildAgentFor: (input: {
    ownerUserId: string;
    agentId: string;
  }) => Promise<AbstractAgent>;
  /** How long one headless turn may take before it is stopped. */
  turnTimeoutMs?: number;
  lockTtlSeconds?: number;
  heartbeatMs?: number;
  /** See {@link DEFAULT_ABORT_GRACE_MS}. */
  abortGraceMs?: number;
}): TurnRunner {
  const {
    threads,
    runner,
    buildAgentFor,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  } = options;

  return async ({ ownerUserId, agentId, threadId, instruction }) => {
    /*
     * One id for this turn, minted once.
     *
     * The same value goes to acquire, renew, stop, and release. Re-minting it is how a renew keeps a
     * different lease alive than the one release clears.
     */
    const runId = crypto.randomUUID();

    /*
     * A routine may be the first thing to touch this thread, so ensure it before reading history.
     */
    await threads.ensure({
      threadId,
      userId: ownerUserId,
      agentId,
    });

    /*
     * History, seeded by us because nobody else will.
     *
     * A headless turn has no browser request carrying history, so it loads the native transcript.
     *
     * And sanitized on the way in — see {@link sanitizeSeededHistory}, which is the difference
     * between a routine that survives one interrupted chat turn and one that never fires again.
     */
    const history = await threads.history({ threadId, userId: ownerUserId });

    const seeded = sanitizeSeededHistory(history);
    /*
     * This turn's own message — and the ONLY message that is framed. See {@link frameFiring} for the
     * firing it did nothing on. The seeded history above is untouched, which is what keeps a previous
     * firing's framed message (it persisted, so it is back here as history) from being framed twice.
     */
    const turn = {
      id: crypto.randomUUID(),
      role: "user",
      content: frameFiring(instruction),
    } as Message;
    const messages = [...seeded, turn];

    /*
     * WHAT THIS RUN IS ALLOWED TO PERSIST, and it is mandatory.
     *
     * Set subtraction is by id, not position, so a firing persists only its new input rather than
     * doubling the transcript on every schedule.
     */
    const historicIds = new Set(history.map((message) => message.id));
    const persistedInputMessages = messages.filter(
      (message) => !historicIds.has(message.id),
    );

    /*
     * The Bot, resolved as its owner, and pointed at this thread.
     *
     * The agent owns its thread and message state; the runner adds the durable run lifecycle.
     */
    const agent = await buildAgentFor({ ownerUserId, agentId });
    agent.threadId = threadId;
    agent.setMessages(messages);

    const input: RunAgentInput = {
      threadId,
      runId,
      messages,
      state: agent.state,
      // Empty because a headless turn has no browser to register frontend tools. What the Bot itself
      // may call is decided where it is built, not here.
      tools: [],
      context: [],
      forwardedProps: undefined,
    };

    /*
     * The reply is recovered by diffing the agent because the observable carries events rather than
     * the `RunAgentResult`. This is the before-picture.
     */
    const before = new Set(agent.messages.map((message) => message.id));
    const chunks: string[] = [];
    const spoken = agent.subscribe({
      onTextMessageEndEvent: ({ textMessageBuffer }) => {
        if (textMessageBuffer.length > 0) chunks.push(textMessageBuffer);
      },
    });

    await threads.acquire({
      threadId,
      runId,
      userId: ownerUserId,
      agentId,
      ttlSeconds: lockTtlSeconds,
    });

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let heartbeatError: unknown;
    /** Whether the deadline stopped this turn. See the throw below the `finally`. */
    let stopped = false;
    /**
     * `stopCanonicalRun`'s shape (`channel-manager.mjs:222-229`): one promise for the whole turn,
     * not one per caller. Both the heartbeat-reject path and the deadline path call `stopTurn`, and
     * without the `??=` each would issue its own `runner.stop`, which is two stops racing each other
     * for one run id. The seam note above about the acquire echo applies here too: if this file ever
     * adopts the acquired `threadId`/`runId` instead of minting its own, it must guard the echo the
     * way `run.mjs:94` does — `lock.threadId || threadId` — before trusting it, not use it bare.
     */
    let stopPromise: Promise<boolean | undefined> | undefined;

    const clearHeartbeat = () => {
      if (heartbeat === undefined) return;
      clearInterval(heartbeat);
      heartbeat = undefined;
    };

    /** Stop this exact run, both ends: the agent's own abort and the runner's stop flag. */
    const stopTurn = () => {
      try {
        agent.abortRun();
      } catch {
        // An agent that cannot be aborted must not stop us telling the runner to give up. The
        // reason it refused is not actionable here and `runner.stop` is the half that matters:
        // it sets `stopRequested`, which is what makes `finalizeRunEvents` close the run as
        // stopped rather than leaving it open for ever on the platform.
      }
      stopPromise ??= runner.stop({ threadId, runId }).catch(() => undefined);
    };

    heartbeat = setInterval(() => {
      void threads
        .renew({ threadId, runId, ttlSeconds: lockTtlSeconds })
        .catch((error: unknown) => {
          if (heartbeat === undefined) return;
          /*
           * A lock we no longer hold means somebody else is in this thread — the person, most
           * likely, having just typed something. Continuing would write this turn's events into
           * their run, so the turn is stopped and the failure is raised rather than recovered.
           */
          clearHeartbeat();
          heartbeatError = error;
          stopTurn();
        });
    }, heartbeatMs);
    // So a heartbeat that is still pending cannot hold a one-shot process open.
    heartbeat.unref?.();

    try {
      const completed = new Promise<void>((resolve, reject) => {
        let terminal: Error | undefined;
        runner
          .run({ threadId, agent, input, persistedInputMessages })
          .subscribe({
            /*
             * RUN_ERROR THROUGH `next` IS TERMINAL. An agent reports a failed run by emitting
             * RUN_ERROR and then completing; `error` is for transport or durability. A RUN_ERROR not caught here would
             * therefore arrive as a successful completion, and the turn would look like a Bot that
             * answered with nothing.
             */
            next: (event) => {
              if (event.type !== EventType.RUN_ERROR || terminal) return;
              const message =
                "message" in event && typeof event.message === "string"
                  ? event.message
                  : "The routine's turn failed.";
              terminal = new Error(message);
              terminal.name = "RoutineTurnRunError";
            },
            error: reject,
            complete: () => {
              if (terminal) reject(terminal);
              else resolve();
            },
          });
      });

      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          stopped = true;
          stopTurn();
        }, turnTimeoutMs);
        deadline.unref?.();
        backstop = setTimeout(() => {
          reject(
            new Error(
              `The routine's turn did not finish within ${Math.round(turnTimeoutMs / 1000)}s and could not be stopped.`,
            ),
          );
        }, turnTimeoutMs + abortGraceMs);
        backstop.unref?.();
      });

      await Promise.race([completed, timeout]);
    } finally {
      /*
       * THE SINGLE MOST IMPORTANT LINES IN THIS FILE, on every exit path — success, a thrown run, the
       * deadline, a failed heartbeat.
       *
       * While this lock is held, the person's next browser message is refused with 409 "Thread lock
       * denied" (`run.mjs:85-92`) for the whole TTL. A routine that fails quietly and leaks its lock
       * does not just fail: it locks somebody out of their own conversation, at three in the morning,
       * for a reason no screen explains. `.catch` because a cleanup that cannot be reached must not
       * replace the real failure with a second one — the TTL is the backstop for that case.
       */
      clearHeartbeat();
      if (deadline !== undefined) clearTimeout(deadline);
      if (backstop !== undefined) clearTimeout(backstop);
      spoken.unsubscribe();
      await threads.release({ threadId, runId }).catch(() => undefined);
    }

    // Raised after the lock is released, and ahead of any reply: a turn that lost its lock partway
    // through is not a turn that answered, however much text it produced first. `stopPromise` is
    // awaited first — the reference's own order (`channel-manager.mjs:311-313`) — so a stop this
    // path itself requested has actually settled before we report on it, not just been requested.
    if (heartbeatError !== undefined) {
      await stopPromise;
      throw heartbeatError;
    }

    /*
     * And the same for a turn the deadline stopped, even when the abort worked and the run then
     * completed inside the grace window. A stopped run is a truncated one: whatever text it had
     * reached is half a sentence, and returning it here would post it into the channel as the answer
     * and close the firing as a success.
     */
    if (stopped) {
      await stopPromise;
      throw new Error(
        `The routine's turn was stopped after ${Math.round(turnTimeoutMs / 1000)}s.`,
      );
    }

    const said = agent.messages
      .filter((message) => !before.has(message.id))
      .map(assistantText)
      .filter((text): text is string => text !== undefined);
    // The diff first, the streamed chunks as the fallback: the diff is what was persisted, which is
    // what the person will read in the channel, and the chunks are only what went past.
    const replyText = (said.length > 0 ? said : chunks).join("\n\n");

    /*
     * An interrupt is an unfinished turn with nobody to ask, and it is checked BEFORE the empty-reply
     * case below. A turn that interrupted before saying anything has both conditions true at once,
     * and only one sentence can go on the run row and into the channel: "finished without saying
     * anything" would be a lie about a turn that in fact stopped to ask a question. The Bot stopped
     * to put a question to a person who is not there, so whatever it said first is half of an
     * exchange. Posting it as the answer would be the worst of the options: the routine would read as
     * successful and the channel would carry a reply that is waiting on something.
     */
    if (agent.pendingInterrupts.length > 0) {
      throw new Error(
        "The turn stopped to ask a question, and a routine has nobody to ask.",
      );
    }
    if (replyText.length === 0) {
      throw new Error("The turn finished without saying anything.");
    }

    return { replyText };
  };
}
