import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { UnstartedAgentConversation } from "../src/components/app-sidebar/agent-conversation";
import type { AgentProfile } from "../src/lib/agents/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const agent: AgentProfile = {
  id: "agent-researcher",
  name: "Researcher",
  title: "Finds the evidence",
  roleDescription: "Research questions and report sources.",
  avatarSeed: "agent-researcher",
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

test("a first-open request keeps the agent row visually stable", () => {
  const view = render(
    <UnstartedAgentConversation
      agent={agent}
      onOpen={() => undefined}
      pending={false}
      problem={null}
    />,
  );

  expect(view.getByText(agent.title)).toBeTruthy();
  expect(view.queryByText("Opening conversation…")).toBeNull();
  expect(view.queryByText("Working…")).toBeNull();

  view.rerender(
    <UnstartedAgentConversation
      agent={agent}
      onOpen={() => undefined}
      pending
      problem={null}
    />,
  );

  expect(view.getByText(agent.title)).toBeTruthy();
  expect(view.queryByText("Opening conversation…")).toBeNull();
  expect(view.queryByText("Working…")).toBeNull();
  expect(view.getByRole("button").getAttribute("aria-busy")).toBe("true");
});
