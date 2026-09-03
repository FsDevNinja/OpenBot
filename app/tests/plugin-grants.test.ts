import { afterEach, expect, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import {
  grantPlugin,
  grantPlugins,
  setAgentConnectorCapability,
  setPluginGrantMutationOptions,
} from "../src/lib/plugins/mutations";

/**
 * Granting a batch of tools, and what a batch is allowed to cost.
 *
 * Exact grants remain available to older and administrator callers. The coworker screen now sends
 * one connector-sized capability decision and lets the server replace the exact set atomically.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type SeenRequest = { url: string; init: RequestInit | undefined };

function capturingFetch(status: number, body: unknown) {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return seen;
}

function invalidationRecorder() {
  const invalidated: unknown[] = [];
  const queryClient = {
    invalidateQueries: async (filter: unknown) => {
      invalidated.push(filter);
    },
  } as unknown as QueryClient;
  return { queryClient, invalidated };
}

test("one grant is one POST of the three things it joins", async () => {
  const seen = capturingFetch(200, {});

  await grantPlugin({ agentId: "agent-1", kind: "mcp", ref: "notion/search" });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/plugins/grants");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    agentId: "agent-1",
    kind: "mcp",
    ref: "notion/search",
  });
});

test("a batch of grants is N grant requests and nothing else", async () => {
  const seen = capturingFetch(200, {});

  for (const ref of ["notion/search", "notion/fetch", "notion/create"]) {
    await grantPlugin({ agentId: "agent-1", kind: "mcp", ref });
  }

  // Three writes, and no read in between: the refetch belongs to the caller, once, at the end.
  expect(seen.map((request) => request.init?.method)).toEqual([
    "POST",
    "POST",
    "POST",
  ]);
});

test("a bulk grant is one request regardless of the number of tool and Bot pairs", async () => {
  const seen = capturingFetch(200, { granted: 6 });

  await grantPlugins({
    agentIds: ["agent-1", "agent-2"],
    refs: ["github/search", "github/list", "github/get"],
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/plugins/grants/bulk");
  expect(seen[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    kind: "mcp",
    refs: ["github/search", "github/list", "github/get"],
    agentIds: ["agent-1", "agent-2"],
  });
});

test("a coworker capability is one connector-sized decision", async () => {
  const seen = capturingFetch(200, { tools: 749 });

  await setAgentConnectorCapability({
    agentId: "researcher",
    serverId: "composio-github",
    level: "write",
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/plugins/grants/capability");
  expect(seen[0]?.init?.method).toBe("PUT");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
    agentId: "researcher",
    serverId: "composio-github",
    level: "write",
  });
});

test("a refused grant carries the server's own sentence", async () => {
  capturingFetch(403, { error: "That Agent is defined by the package." });

  await expect(
    grantPlugin({ agentId: "agent-1", kind: "mcp", ref: "notion/search" }),
  ).rejects.toThrow("That Agent is defined by the package.");
});

test("granting one on its own still carries its refetch", async () => {
  const seen = capturingFetch(200, {});
  const { queryClient, invalidated } = invalidationRecorder();
  const options = setPluginGrantMutationOptions(queryClient);

  await options.mutationFn?.({
    agentId: "agent-1",
    granted: true,
    kind: "mcp",
    ref: "notion/search",
  });
  await options.onSuccess?.(
    undefined as never,
    {
      agentId: "agent-1",
      granted: true,
      kind: "mcp",
      ref: "notion/search",
    },
    undefined as never,
    undefined as never,
  );

  expect(seen).toHaveLength(1);
  expect(invalidated).toEqual([{ queryKey: ["plugins"] }]);
});
