import {
  browserAction,
  browserResult,
  type BrowserSession,
} from "../channels/browser-sessions";
import { useDeclaredBotId } from "@/lib/agent/active-bot";
import { ComputerView } from "./computer-view";
import { useNeedsYou } from "./needs-you";

const ACTION_LABELS: Record<string, string> = {
  navigate: "Open page",
  read: "Read page",
  snapshot: "Inspect page",
  click: "Click",
  type: "Type",
  key: "Press key",
  scroll: "Scroll",
  request_help: "Request your help",
  request_secret: "Request a credential",
};

export function BrowserSessionCard({ session }: { session: BrowserSession }) {
  const computerId = useDeclaredBotId();
  // A bounded provider help call may finish before the person returns. Keep that request usable.
  const needsYou = useNeedsYou(
    computerId,
    session.current && !session.active,
    true,
  );
  const active = session.active || (session.current && needsYou);
  if (!computerId) return null;
  return (
    <section
      aria-label="Browser session"
      className="my-2 space-y-2"
      data-browser-session={session.id}
    >
      <ComputerView
        computerId={computerId}
        active={active}
        finished={!active}
        sessionControls
        retainHumanControl={session.current}
        {...(session.frameId ? { toolCallId: session.frameId } : {})}
        {...(session.page ? { page: session.page } : {})}
      />
      <details className="text-muted-foreground text-xs">
        <summary className="cursor-pointer py-1">
          {session.calls.length} browser{" "}
          {session.calls.length === 1 ? "action" : "actions"}
        </summary>
        <ol className="mt-2 space-y-2 pl-4">
          {session.calls.map((call) => {
            const result = browserResult(call.result);
            const failed =
              result.ok === false ||
              call.result?.startsWith("Refused.") ||
              call.result?.startsWith("Error:");
            const reason =
              typeof result.reason === "string"
                ? result.reason
                : typeof result.error === "string"
                  ? result.error
                  : failed
                    ? call.result
                    : undefined;
            return (
              <li
                key={call.id}
                className={failed ? "text-destructive" : undefined}
              >
                {ACTION_LABELS[
                  browserAction(call.toolCall.function.name) ?? ""
                ] ?? "Browser action"}
                {call.result === undefined
                  ? active
                    ? " · Working"
                    : " · Interrupted"
                  : failed
                    ? " · Failed"
                    : " · Done"}
                {failed && reason ? (
                  <p className="mt-1 whitespace-pre-wrap">{reason}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
