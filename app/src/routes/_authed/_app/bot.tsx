import type { Message } from "@ag-ui/core";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationView } from "@/components/channels/conversation-view";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useActiveBot } from "@/lib/agent/active-bot";
import { useBotThread } from "@/lib/agent/bot-thread";
import { ConversationProvider } from "@/lib/agent/conversation";
import { repairUnansweredToolCalls } from "@/lib/agent/repair-history";
import { stoppedReason } from "@/lib/agent/stopped-turn";
import { readThreadMessages } from "@/lib/agent/thread-messages";
import { newId } from "@/lib/new-id";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { useAgent, useOpenBotRuntime } from "@/lib/runtime/provider";

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
      <div className="flex h-screen items-center justify-center p-6">
        <p className="text-muted-foreground text-sm">
          {agent
            ? `This deployment has no Bot called "${agent}".`
            : "This deployment has no Bots yet."}
        </p>
      </div>
    );
  }
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  useActiveBot(agentId);
  const { threadId, history, startNew } = useBotThread(agentId);

  return (
    <div className="flex h-screen flex-col">
      <SidebarToggleBar />
      <header className="border-b px-6 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">{name}</h1>
          <Button onClick={startNew} size="sm" variant="ghost">
            <IconPlus />
            New chat
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
      {history === "unavailable" ? (
        <p
          className="border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          role="alert"
        >
          Earlier messages could not be loaded. This conversation was kept
          rather than discarded.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {threadId ? (
          <NativeBotConversation
            agentId={agentId}
            key={`${agentId}:${threadId}`}
            name={name}
            threadId={threadId}
          />
        ) : null}
      </div>
    </div>
  );
}

function NativeBotConversation({
  agentId,
  name,
  threadId,
}: {
  agentId: string;
  name: string;
  threadId: string;
}) {
  const { agent } = useAgent({ agentId, threadId });
  const { runtime } = useOpenBotRuntime();
  const commands = useSkillCommands(agentId);
  const [restoring, setRestoring] = useState(true);
  const [stopped, setStopped] = useState<string | null>(null);
  const [turns, setTurns] = useState(0);
  const turnRef = useRef(0);

  useEffect(() => {
    let current = true;
    void readThreadMessages(threadId, agentId).then((stored) => {
      if (!current) return;
      agent.setMessages(stored.messages as Message[]);
      setRestoring(false);
    });
    return () => {
      current = false;
    };
  }, [agent, agentId, threadId]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const say = async (text: string, instructions: string[] = []) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    turnRef.current += 1;
    setTurns(turnRef.current);
    try {
      for (const instruction of instructions) {
        agent.addMessage({ id: newId(), role: "system", content: instruction });
      }
      agent.addMessage({ id: newId(), role: "user", content: trimmed });
      const repaired = repairUnansweredToolCalls(agent.messages);
      if (repaired !== agent.messages) agent.setMessages(repaired as Message[]);
      await runtime.runAgent({ agent });
    } finally {
      turnRef.current -= 1;
      setTurns(turnRef.current);
    }
  };
  const sayRef = useRef(say);
  sayRef.current = say;
  const ask = useCallback((text: string) => void sayRef.current(text), []);
  const busy = turns > 0 || agent.isRunning;

  return (
    <ConversationProvider ask={ask}>
      <ConversationView
        agents={[{ id: agentId, name }]}
        busy={busy}
        commands={commands}
        messages={agent.messages as Message[]}
        onStop={() => runtime.stopAgent({ agent })}
        onSubmit={(draft) =>
          say(
            draft.text,
            draft.commandIds.flatMap((id) => {
              const prompt = commands.find(
                (command) => command.id === id,
              )?.prompt;
              return prompt ? [prompt] : [];
            }),
          )
        }
        pending={busy}
        restoring={restoring}
        stoppable={agent.isRunning}
        stopped={stopped ?? undefined}
      />
    </ConversationProvider>
  );
}
