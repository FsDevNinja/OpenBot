import { describe, expect, test } from "bun:test";
import { mentionTriggerConfig } from "../src/components/channels/composer/triggers";

describe("the @ mention source", () => {
  test("searches coworkers and connected accounts together with distinct values", async () => {
    const trigger = mentionTriggerConfig(
      [{ id: "researcher", name: "Researcher", description: "Finds facts" }],
      [{ id: "composio-github", name: "GitHub", description: "GitHub" }],
    );

    const all = await trigger.onSearch?.("", {
      signal: new AbortController().signal,
    });

    expect(all).toEqual([
      {
        value: "agent:researcher",
        label: "Researcher",
        description: "Agent · Finds facts",
      },
      {
        value: "connection:composio-github",
        label: "GitHub",
        description: "Connected account · GitHub",
      },
    ]);
  });

  test("finds a connection by its vendor description", async () => {
    const trigger = mentionTriggerConfig(
      [],
      [
        { id: "composio-github", name: "GitHub", description: "GitHub" },
        { id: "composio-linear", name: "Linear", description: "Linear" },
      ],
    );

    const matches = await trigger.onSearch?.("git", {
      signal: new AbortController().signal,
    });

    expect(matches?.map((item) => item.label)).toEqual(["GitHub"]);
  });
});
