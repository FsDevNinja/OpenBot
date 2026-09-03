import { expect, test } from "bun:test";
import { AGENT_DIALOG_LAYOUT_CLASS } from "@/components/agents/agent-dialog";

test("the coworker dialog gives its sidebar and content one shared height", () => {
  const classes = AGENT_DIALOG_LAYOUT_CLASS.split(" ");

  expect(classes).toContain("h-[640px]");
  expect(classes).toContain("max-h-[80svh]");
  expect(classes).toContain("min-h-0");
  expect(classes).not.toContain("items-start");
});
