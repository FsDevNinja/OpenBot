import { useEffect, useState } from "react";
import { readControl } from "@/lib/computers/control";

/**
 * Poll closed screens for control/secret prompts so blocked Bots can surface outside the screen.
 */

const INTERVAL_MS = 3_000;

export function useNeedsYou(
  botId: string | undefined,
  when: boolean,
  includeHumanControl = false,
): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!botId || !when) {
      setNeeded(false);
      return;
    }

    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const state = await readControl(botId).catch(() => null);
      if (!live) return;
      // An unavailable read is not a cleared request. Keep the last known state on transient errors.
      if (state) {
        setNeeded(
          Boolean(
            state.requested ||
              state.secretWanted !== undefined ||
              (includeHumanControl && state.holder === "human"),
          ),
        );
      }
      // Do not pile up concurrent ensures when the computer supervisor is slow.
      timer = setTimeout(() => void check(), INTERVAL_MS);
    };

    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [botId, when, includeHumanControl]);

  return needed;
}
