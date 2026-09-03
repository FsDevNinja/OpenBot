import { expect, test } from "bun:test";
import {
  buildConversationRoster,
  pinnedFirst,
} from "../src/components/app-sidebar/app-sidebar";
import type { AgentProfile } from "../src/lib/agents/queries";
import type { ChannelSummary } from "../src/lib/channels/queries";

/** A minimal but fully-typed channel summary, so tests build real objects rather than casts. */
function channel(id: string, pinned: boolean): ChannelSummary {
  return {
    id,
    name: id,
    agentIds: [],
    threadId: `thread-${id}`,
    active: true,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    pinned,
    lastReadAt: null,
  };
}

function agent(id: string): AgentProfile {
  return {
    id,
    name: id,
    title: `${id} title`,
    roleDescription: `${id} role`,
    avatarSeed: id,
    avatarUrl: null,
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: true,
    hasCallbackToken: false,
    hidden: false,
    systemOwned: false,
    canManage: true,
    canCustomizeAvatar: true,
    mine: true,
  };
}

test("holds pinned channels at the top, newest-activity order preserved within each group", () => {
  /*
   * Interleaved, which is what the cache can hold between refetches: the server hands back
   * pinned-first, and then the socket patches a pin onto a loaded row without moving it, or re-sorts
   * a page by recency alone. This function is the render-level mirror that closes that window.
   */
  const channels = [
    channel("a", false),
    channel("b", true),
    channel("c", false),
    channel("d", true),
    channel("e", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual([
    "b",
    "d",
    "a",
    "c",
    "e",
  ]);
});

test("leaves an all-unpinned roster in its original order", () => {
  const channels = [
    channel("a", false),
    channel("b", false),
    channel("c", false),
  ];

  expect(pinnedFirst(channels).map((c) => c.id)).toEqual(["a", "b", "c"]);
});

test("shows each available agent once and keeps multi-agent channels as groups", () => {
  const first = channel("direct-new", false);
  first.agentIds = ["researcher"];
  const duplicate = channel("direct-old", false);
  duplicate.agentIds = ["researcher"];
  const group = channel("group", false);
  group.agentIds = ["researcher", "writer"];

  const roster = buildConversationRoster(
    [agent("researcher"), agent("writer"), agent("reviewer")],
    [first, duplicate, group],
  );

  expect(
    roster.agents.map(({ agent: profile, channel: conversation }) => [
      profile.id,
      conversation?.id,
    ]),
  ).toEqual([
    ["researcher", "direct-new"],
    ["writer", undefined],
    ["reviewer", undefined],
  ]);
  expect(roster.groups.map((conversation) => conversation.id)).toEqual([
    "group",
  ]);
});

test("does not leak a channel for an agent absent from the visible roster", () => {
  const privateConversation = channel("private-conversation", false);
  privateConversation.agentIds = ["somebody-else"];

  const roster = buildConversationRoster(
    [agent("researcher")],
    [privateConversation],
  );

  expect(roster.agents).toEqual([{ agent: agent("researcher") }]);
  expect(roster.groups).toEqual([]);
});
