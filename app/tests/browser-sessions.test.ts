import { describe, expect, test } from "bun:test";
import {
  browserAction,
  groupBrowserSessions,
  type BrowserSession,
} from "@/components/channels/browser-sessions";
import type { VisibleChatItem } from "@/components/channels/chat-messages";

const user = (id: string): VisibleChatItem => ({
  kind: "text",
  id,
  role: "user",
  text: id,
});
const tool = (id: string, name: string, result?: unknown): VisibleChatItem => ({
  kind: "tool",
  id,
  toolCall: { id, type: "function", function: { name, arguments: "{}" } },
  ...(result === undefined ? {} : { result: JSON.stringify(result) }),
});
const sessions = (items: VisibleChatItem[], busy: boolean) =>
  groupBrowserSessions(items, busy).filter(
    (item): item is BrowserSession => item.kind === "browser",
  );

describe("browser sessions in the transcript", () => {
  test("one stable card spans navigation, thinking, reading and takeover for the whole reply", () => {
    const items = [
      user("one"),
      tool("nav", "openbot_computer_navigate", {
        ok: true,
        url: "https://example.com",
      }),
    ];
    const first = sessions(items, true)[0];
    items.push(
      { kind: "text", role: "assistant", id: "thinking", text: "Checking…" },
      tool("read", "openbot_computer_read", { ok: true }),
      tool("help", "openbot_computer_request_help"),
    );
    const grouped = groupBrowserSessions(items, true);
    expect(sessions(items, true)).toHaveLength(1);
    expect(sessions(items, true)[0]).toMatchObject({
      id: first.id,
      active: true,
    });
    expect(sessions(items, true)[0].calls).toHaveLength(3);
    expect(grouped.some((item) => item.id === "thinking")).toBe(true);
    expect(sessions(items, false)[0].active).toBe(false);
  });
  test("never makes an old card live when the next user message is still waiting for a browser call", () => {
    const items = [user("one"), tool("a", "computer_navigate"), user("two")];
    expect(sessions(items, true)[0]).toMatchObject({
      active: false,
      current: false,
    });
    items.push(tool("b", "openbot_computer_navigate"));
    expect(sessions(items, true).map((item) => item.active)).toEqual([
      false,
      true,
    ]);
  });
  test("restores the last saved action frame and keeps failures without replacing it", () => {
    const items = [
      user("one"),
      tool("a", "openbot_computer_navigate", {
        pageFrame: { id: "frame-a", url: "https://example.com/a" },
      }),
      tool("b", "openbot_computer_click", {
        pageFrame: { id: "frame-b", url: "https://example.com/b" },
      }),
      tool("c", "openbot_computer_click", { ok: false, reason: "Refused" }),
    ];
    expect(sessions(items, false)[0]).toMatchObject({
      frameId: "frame-b",
      page: { url: "https://example.com/b" },
      active: false,
    });
    expect(sessions(items, false)[0].calls).toHaveLength(3);
  });
  test("leaves unrelated tools and text intact, without modifying runtime history", () => {
    const items = [
      user("one"),
      tool("a", "openbot_computer_navigate"),
      tool("shell", "openbot_computer_run_command"),
      tool("github", "mcp__github__list"),
    ];
    const before = JSON.stringify(items);
    expect(groupBrowserSessions(items, true).map((item) => item.id)).toEqual([
      "one",
      "browser-a",
      "shell",
      "github",
    ]);
    expect(JSON.stringify(items)).toBe(before);
    expect(browserAction("navigate")).toBeUndefined();
    expect(browserAction("mcp__computer_navigate")).toBeUndefined();
  });
  test("malformed results and interrupted calls can still be read in history", () => {
    const broken = tool("a", "openbot_computer_navigate");
    if (broken.kind === "tool") broken.result = "Refused. Not allowed.";
    expect(sessions([broken], false)[0]).toMatchObject({ active: false });
  });
});
