import type { VisibleChatItem } from "./chat-messages";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

const BROWSER_ACTIONS = new Set([
  "navigate",
  "read",
  "snapshot",
  "click",
  "type",
  "key",
  "scroll",
  "request_help",
  "request_secret",
]);

export function browserAction(name: string): string | undefined {
  const action = name.replace(/^openbot_/, "").replace(/^computer_/, "");
  return /^(openbot_)?computer_/.test(name) && BROWSER_ACTIONS.has(action)
    ? action
    : undefined;
}

export type BrowserSession = {
  kind: "browser";
  id: string;
  turnId: string;
  current: boolean;
  active: boolean;
  calls: ToolItem[];
  frameId?: string;
  page?: { url: string; title?: string };
};

export function browserResult(result?: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(result ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Presentation only: keep every message/tool in runtime history, group browser calls per reply. */
export function groupBrowserSessions(
  items: VisibleChatItem[],
  busy: boolean,
): (VisibleChatItem | BrowserSession)[] {
  const grouped: (VisibleChatItem | BrowserSession)[] = [];
  const sessions: BrowserSession[] = [];
  let turnId = "initial";
  let session: BrowserSession | undefined;
  for (const item of items) {
    if (item.kind === "text" && item.role === "user") {
      turnId = item.id;
      session = undefined;
    }
    if (item.kind !== "tool" || !browserAction(item.toolCall.function.name)) {
      grouped.push(item);
      continue;
    }
    if (!session) {
      session = {
        kind: "browser",
        id: `browser-${item.id}`,
        turnId,
        current: false,
        active: false,
        calls: [],
      };
      sessions.push(session);
      grouped.push(session);
    }
    session.calls.push(item);
    const result = browserResult(item.result);
    const frame = result.pageFrame as
      | { id?: unknown; url?: unknown; title?: unknown }
      | undefined;
    if (
      frame &&
      typeof frame.id === "string" &&
      typeof frame.url === "string"
    ) {
      session.frameId = frame.id;
      session.page = {
        url: frame.url,
        ...(typeof frame.title === "string" ? { title: frame.title } : {}),
      };
    } else if (result.ok !== false && typeof result.url === "string") {
      // Older/frontend navigation stores a frame under the tool call's protocol identity.
      session.page = {
        url: result.url,
        ...(typeof result.title === "string" ? { title: result.title } : {}),
      };
      session.frameId = item.toolCall.id;
    }
  }
  for (const entry of sessions) {
    entry.current = entry.turnId === turnId;
    entry.active = busy && entry.current;
  }
  return grouped;
}
