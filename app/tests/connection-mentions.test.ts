import { describe, expect, test } from "bun:test";
import { connectionMentionInstructions } from "../src/lib/plugins/connection-mentions";

const options = [
  { id: "composio-github", name: "GitHub", description: "GitHub" },
  { id: "composio-notion", name: "Notion", description: "Notion" },
];

describe("connection mention instructions", () => {
  test("focuses the selected connected account without claiming to grant it", () => {
    const [instruction] = connectionMentionInstructions(
      ["composio-github"],
      options,
    );

    expect(instruction).toContain("GitHub");
    expect(instruction).toContain("mcp__composio-github__");
    expect(instruction).toContain("does not grant any new tool or permission");
    expect(instruction).toContain("Do not substitute a browser login");
  });

  test("ignores a stale connection id that is no longer in the person's list", () => {
    expect(connectionMentionInstructions(["somebody-elses"], options)).toEqual(
      [],
    );
  });

  test("deduplicates a connection selected more than once", () => {
    const [instruction] = connectionMentionInstructions(
      ["composio-github", "composio-github"],
      options,
    );

    expect(instruction?.match(/mcp__composio-github__/g)).toHaveLength(1);
  });
});
