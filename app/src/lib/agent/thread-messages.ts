import { type Message, MessageSchema } from "@ag-ui/core";
import { tryClient } from "@/lib/client";

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * A plain fail-closed function rather than a query. Nothing caches it — the transcript this seeds is
 * then owned by the running agent, so a cached copy would be a second version of the same
 * conversation — and an unreadable history is not a reason to keep somebody from typing. Every
 * failure returns nothing and lets the composer open.
 *
 * WHAT ARRIVES HERE IS NOT TRUSTED. This used to end `stored as Message[]`, which is a cast rather
 * than a check: whatever the history store held was handed to `setMessages` and then to every
 * projection that reads a transcript. A turn shaped differently reached a renderer that dereferenced
 * `toolCall.function.arguments` and took the whole conversation down with it. One bad turn made a
 * thread unreadable.
 *
 * So each turn is parsed against the schema AG-UI ships, and one that does not parse is left out.
 * Checked here rather than in a projection because there are several projections and one history:
 * fixing it in the reader that is closest to the wire is what makes every consumer safe at once.
 *
 * BUT `{id, name, args}` IS NOT A CORRUPTION, AND TREATING IT AS ONE DELETED REAL WORK. That shape
 * was read as damage from an interrupted run and dropped. It is how the runtime persists every tool
 * call it stores, so dropping it meant every turn in which a Bot used a tool vanished on reload: the
 * transcript kept the sentence the Bot wrote and lost the browsing that produced it, the inline
 * screen went with it, and the footer said some messages could not be read. Observed against a live
 * thread, where every browsing turn was counted unreadable and every one of them was well formed in
 * the store's own dialect.
 *
 * So it is translated rather than refused. The check stays for turns that really are malformed; a
 * reader is entitled to insist on one shape, but not to throw away the history because the writer
 * spells it another way.
 */

/**
 * What a read gives back: the turns that parsed, and how many did not.
 *
 * The count is returned rather than logged. A turn quietly missing from a record people read back is
 * worse than a visible failure — it is a conversation that reads as though it never had that message,
 * with nothing to say otherwise. The caller is expected to say so on screen.
 */
export type StoredThread = {
  messages: Message[];
  /** Zero on every ordinary read. Above zero means the history store holds something unreadable. */
  unreadable: number;
};

const NOTHING: StoredThread = { messages: [], unreadable: 0 };

/**
 * Add durable history that is not already represented by the live transcript.
 *
 * A streamed tool call and its persisted copy can have different outer message ids: the live AG-UI
 * client uses the tool-call id for its assistant message, while the history reader wraps that same
 * call in an `assistant-${toolCallId}` message. Message-id-only merging therefore drew the same tool
 * twice. Tool-call ids are the stable protocol identity, so calls and their results are compared by
 * that identity while ordinary messages continue to be compared by message id.
 *
 * The original array is returned when there is no news. Besides avoiding a state update, that makes
 * the no-op behavior explicit to callers and tests.
 */
export function mergeStoredMessages(
  current: Message[],
  stored: ReadonlyArray<Readonly<Message>>,
): Message[] {
  const messageIds = new Set(current.map((message) => message.id));
  const toolCallIds = new Set(
    current.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => call.id)
        : [],
    ),
  );
  const toolResultIds = new Set(
    current.flatMap((message) =>
      message.role === "tool" && "toolCallId" in message
        ? [message.toolCallId]
        : [],
    ),
  );
  const fresh: Message[] = [];

  for (const message of stored) {
    if (messageIds.has(message.id)) continue;

    let candidate = message as Message;
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      const unseenCalls = calls.filter((call) => !toolCallIds.has(call.id));
      const hasContent = Boolean(message.content);

      // A differently named wrapper around calls already on screen carries no new information.
      if (calls.length > 0 && unseenCalls.length === 0 && !hasContent) continue;
      if (unseenCalls.length !== calls.length) {
        candidate = { ...message, toolCalls: unseenCalls } as Message;
      }
    } else if (
      message.role === "tool" &&
      "toolCallId" in message &&
      toolResultIds.has(message.toolCallId)
    ) {
      continue;
    }

    fresh.push(candidate);
    messageIds.add(candidate.id);
    if (candidate.role === "assistant") {
      for (const call of candidate.toolCalls ?? []) toolCallIds.add(call.id);
    } else if (candidate.role === "tool" && "toolCallId" in candidate) {
      toolResultIds.add(candidate.toolCallId);
    }
  }

  return fresh.length === 0 ? current : [...current, ...fresh];
}

/**
 * Rebuild a page-load transcript from complete durable history and any newer live replay.
 *
 * The connect stream is allowed to resume from a cursor, so even a newly mounted browser can receive
 * only a suffix or a single message. Durable history owns the conversation's order; semantic merging
 * then keeps a message that arrived through the live connection before the history read completed.
 */
export function restoreThreadMessages(
  replayed: Message[],
  stored: Message[],
): Message[] {
  return mergeStoredMessages(stored, replayed);
}

/**
 * The turns that parse, kept in order, and a count of the ones that did not.
 *
 * Exported so it can be tested against real stored shapes without a server. Takes `unknown[]`
 * because that is honestly what the wire gives.
 *
 * THE ORIGINAL OBJECT IS KEPT, not `parsed.data`. Zod strips keys a schema does not name, so
 * returning the parsed copy would quietly drop anything the runtime carries and this file has not
 * heard of — turning a validation step into a silent rewrite of every message that passed. The parse
 * is asked whether the turn is well formed; it is not asked to decide what the turn contains.
 */
export function readableTurns(stored: readonly unknown[]): StoredThread {
  const messages: Message[] = [];
  let unreadable = 0;

  for (const turn of stored) {
    const candidate = withNormalisedToolCalls(
      withoutNullAssistantContent(turn),
    );
    if (MessageSchema.safeParse(candidate).success) {
      messages.push(candidate as Message);
    } else {
      unreadable += 1;
    }
  }

  return { messages, unreadable };
}

/**
 * An assistant turn whose content is `null`, read as one that simply has no content.
 *
 * The schema makes an assistant's content optional and does not allow it to be null, so the two say
 * the same thing and only one parses. A turn that called a tool and said nothing alongside it is
 * written exactly that way, so this dropped the browsing and kept nothing in its place: the same
 * loss the tool-call dialect caused, arriving by a different route.
 *
 * ASSISTANT ONLY. A user turn's content is required, and `content: null` there is not a message
 * somebody sent; it used to reach a projection and draw as a blank line, which is why it is refused
 * and counted rather than quietly shown. That decision stands.
 */
function withoutNullAssistantContent(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const record = turn as Record<string, unknown>;
  if (record.role !== "assistant" || record.content !== null) return turn;
  const { content: _dropped, ...rest } = record;
  return rest;
}

/** A tool call as the history store writes one. */
type StoredToolCall = { id?: unknown; name?: unknown; args?: unknown };

/**
 * The store's dialect for a tool call, in the shape AG-UI describes.
 *
 * `{id, name, args}` becomes `{id, type: "function", function: {name, arguments}}`. Only the array is
 * rebuilt and only when every entry is in that dialect: a turn already in AG-UI's shape is returned
 * untouched, and a mixed or unrecognised array is left exactly as it came so the parse below still
 * refuses it rather than this quietly inventing something.
 *
 * The rest of the message is spread through unchanged, for the same reason `parsed.data` is not used
 * anywhere here: a reader that rewrites what it does not recognise is worse than one that refuses it.
 */
function withNormalisedToolCalls(turn: unknown): unknown {
  if (typeof turn !== "object" || turn === null) return turn;
  const calls = (turn as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls) || calls.length === 0) return turn;

  const isStoredDialect = (call: unknown): call is StoredToolCall =>
    typeof call === "object" &&
    call !== null &&
    "name" in call &&
    "args" in call &&
    !("function" in call);
  if (!calls.every(isStoredDialect)) return turn;

  return {
    ...(turn as Record<string, unknown>),
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: argumentsOf(call.args) },
    })),
  };
}

/**
 * The arguments, as a string, because that is what the protocol says they are.
 *
 * AG-UI types `arguments` as a string and the store is under no such obligation: it holds whatever
 * the run put there, which for a tool called with structured input is an object. Passing that through
 * produced a call that looked translated and still failed validation, so the turn was dropped anyway.
 * That is this whole function's bug one layer down, which is a good reason to be explicit here rather
 * than to trust the shapes to line up.
 *
 * A string is already right and is left exactly as it is, down to its whitespace: it may be a
 * fragment of a stream that was never valid JSON, and re-encoding it would change what the model
 * actually said. Anything else is encoded. `undefined` becomes `"{}"`, which is what a call with no
 * arguments means and what every reader of this field expects to parse.
 */
function argumentsOf(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    // Circular, or something else that cannot be encoded. An empty object is a call the reader can
    // parse; a throw here would lose the whole conversation over one malformed argument list.
    return "{}";
  }
}

export async function readThreadMessages(
  threadId: string,
  agentId: string,
): Promise<StoredThread> {
  try {
    const response = await tryClient(
      `/api/runtime/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
    );
    if (!response.ok) return NOTHING;
    const stored = (await response.json())?.messages;
    return Array.isArray(stored) ? readableTurns(stored) : NOTHING;
  } catch {
    return NOTHING;
  }
}
