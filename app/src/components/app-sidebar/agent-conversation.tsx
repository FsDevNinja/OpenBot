import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import type { AgentProfile } from "@/lib/agents/queries";
import { directChannelMutationOptions } from "@/lib/channels/mutations";
import type { ChannelSummary } from "@/lib/channels/queries";
import { relativeTime } from "@/lib/relative-time";
import { Channel } from "./channel";

/**
 * One durable teammate in the sidebar.
 *
 * The row exists because the agent exists, not because a channel has already been created. The
 * first click lazily asks the server for this person's canonical conversation; every later click
 * opens that same channel directly. This is the product distinction the old channel-only roster
 * could not express.
 */
export const AgentConversation = memo(function AgentConversation({
  agent,
  channel,
  unread,
}: {
  agent: AgentProfile;
  channel?: ChannelSummary;
  unread: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const direct = useMutation(directChannelMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      channel !== undefined &&
      (params as { channelId?: string }).channelId === channel.id,
  });

  if (channel) {
    return (
      <Channel
        busy={channel.busy ?? false}
        channelId={channel.id}
        kind="agent"
        lastMessage={channel.lastMessage ?? agent.title}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        name={agent.name}
        participantIds={[agent.id]}
        participantImages={[agent.avatarUrl]}
        pinned={channel.pinned}
        unread={unread && !isOpen}
      />
    );
  }

  const open = async () => {
    setProblem(null);
    try {
      const conversation = await direct.mutateAsync(agent.id);
      await navigate({
        params: { channelId: conversation.id },
        to: "/channel/$channelId",
      });
    } catch (caught) {
      setProblem(
        caught instanceof Error
          ? caught.message
          : "Could not open this agent's conversation.",
      );
    }
  };

  return (
    <UnstartedAgentConversation
      agent={agent}
      onOpen={() => void open()}
      pending={direct.isPending}
      problem={problem}
    />
  );
});

/**
 * The row shown before this person's canonical channel has been resolved.
 *
 * Opening is intentionally invisible. The old row changed its subtitle, opacity, and avatar while
 * the request ran, then changed back into a link immediately before navigation. That made a normal
 * route transition look like the agent had briefly started working. Keep the pixels stable, while
 * `disabled` and `aria-busy` still prevent duplicate opens and expose the real state to assistive
 * technology.
 */
export function UnstartedAgentConversation({
  agent,
  onOpen,
  pending,
  problem,
}: {
  agent: AgentProfile;
  onOpen: () => void;
  pending: boolean;
  problem: string | null;
}) {
  return (
    <div>
      <button
        aria-busy={pending}
        className="flex w-full flex-row items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-foreground/5 disabled:cursor-wait"
        disabled={pending}
        onClick={onOpen}
        type="button"
      >
        <ChannelAvatar
          participantIds={[agent.id]}
          participantImages={[agent.avatarUrl]}
          size={32}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] tracking-[-1%]">
            {agent.name}
          </span>
          <span className="h-4 truncate text-[12px] leading-4 text-muted-foreground">
            {agent.title}
          </span>
        </div>
      </button>
      {problem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
