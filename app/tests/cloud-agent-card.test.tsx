import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  type CloudAgentTaskSeed,
  CloudTaskCard,
  seedFrom,
} from "@/lib/copilot/cloud-agent-tools";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a completed cloud task links the transcript to Cursor and its pull request", () => {
  const seed: CloudAgentTaskSeed = {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Add repository search",
    repositoryUrl: "https://github.com/acme/openbot.git",
    model: {
      id: "grok-4.6",
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    status: "succeeded",
    remoteUrl: "https://cursor.com/agents/task-1",
    branch: "cursor/add-repository-search",
    pullRequestUrl: "https://github.com/acme/openbot/pull/42",
    result: "Implemented repository search and added coverage.",
    lastError: null,
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ task: seed }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  try {
    const { getByRole, getByText } = render(
      <QueryClientProvider client={queryClient}>
        <CloudTaskCard seed={seed} />
      </QueryClientProvider>,
    );

    expect(getByText("Completed")).toBeTruthy();
    expect(getByText(/Cursor Grok 4.6/)).toBeTruthy();
    expect(getByText("cursor/add-repository-search")).toBeTruthy();
    expect(getByText(seed.result ?? "")).toBeTruthy();
    expect(
      getByRole("button", { name: /Open in Cursor/ }).getAttribute("href"),
    ).toBe(seed.remoteUrl);
    expect(
      getByRole("button", { name: /Open pull request/ }).getAttribute("href"),
    ).toBe(seed.pullRequestUrl);
  } finally {
    fetchSpy.mockRestore();
    queryClient.clear();
  }
});

test("a remote agent cannot turn a fabricated tool result into an unsafe link", () => {
  expect(
    seedFrom(
      JSON.stringify({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "running",
        remoteUrl: "javascript:alert(document.cookie)",
        pullRequestUrl: "data:text/html,not-a-pull-request",
      }),
    ),
  ).toMatchObject({ remoteUrl: null, pullRequestUrl: null });

  expect(
    seedFrom(
      JSON.stringify({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "running",
        remoteUrl: "https://example.test/fake-cursor-agent",
        pullRequestUrl: "https://example.test/fake-pull-request",
      }),
    ),
  ).toMatchObject({ remoteUrl: null, pullRequestUrl: null });
});

test("a malformed model in a tool result is ignored rather than rendered", () => {
  expect(
    seedFrom(
      JSON.stringify({
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "running",
        model: {
          id: "grok-4.6",
          displayName: "Cursor Grok 4.6",
          params: [{ id: "fast", value: 1 }],
        },
      }),
    ),
  ).toMatchObject({ model: null });
});
