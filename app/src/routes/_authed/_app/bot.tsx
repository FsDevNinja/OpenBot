import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { directChannelMutationOptions } from "@/lib/channels/mutations";

/**
 * Compatibility route for links made before direct Bot chat joined the channel roster.
 *
 * The old screen kept an unrelated thread id in localStorage and exposed "New chat", which let one
 * Bot split into several invisible histories. Resolve the same agent through the server's canonical
 * direct-conversation path now, then hand the browser to the one conversation surface.
 */
export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const { data: agents, isPending } = useQuery(agentListQueryOptions());
  const agentId = agent ?? agents?.[0]?.id;
  const bot = agents?.find((candidate) => candidate.id === agentId);

  if (isPending) return null;
  if (!agentId || !bot) {
    return (
      <div className="flex h-screen flex-col">
        <SidebarToggleBar />
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-muted-foreground text-sm">
            {agent
              ? `This deployment has no agent called "${agent}".`
              : "This deployment has no agents yet."}
          </p>
        </div>
      </div>
    );
  }

  return <OpenCanonicalConversation agentId={agentId} />;
}

function OpenCanonicalConversation({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const direct = useMutation(directChannelMutationOptions(queryClient));
  const { mutateAsync } = direct;

  useEffect(() => {
    let current = true;
    void mutateAsync(agentId)
      .then((channel) => {
        if (!current) return;
        void navigate({
          params: { channelId: channel.id },
          replace: true,
          to: "/channel/$channelId",
        });
      })
      // The mutation owns and renders the error. Catch here so a failed redirect does not also
      // become an unhandled browser rejection.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [agentId, mutateAsync, navigate]);

  return (
    <div className="flex h-screen flex-col">
      <SidebarToggleBar />
      <div className="flex flex-1 items-center justify-center p-6">
        <p
          className={
            direct.error
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
          role={direct.error ? "alert" : "status"}
        >
          {direct.error
            ? direct.error.message
            : "Opening this agent's conversation…"}
        </p>
      </div>
    </div>
  );
}
