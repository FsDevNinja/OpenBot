import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { directChannelMutationOptions } from "./mutations";
import { channelKeys } from "./queries";

/**
 * Send a message into the person's canonical conversation with a Bot, then navigate there.
 *
 * Ordering matters: find-or-create, seed the detail cache, stash the message, then navigate. That
 * keeps the message visible while the durable thread joins, whether the conversation is new or one
 * the person has been using for months.
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const directChannel = useMutation(directChannelMutationOptions(queryClient));

  return {
    pending: directChannel.isPending,
    start: async (
      agentId: string,
      text: string,
      instructions: readonly string[] = [],
    ) => {
      const channel = await directChannel.mutateAsync(agentId);
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
      stashFirstMessage(channel.id, text, instructions);
      await navigate({
        params: { channelId: channel.id },
        replace: true,
        to: "/channel/$channelId",
      });
    },
  };
}
