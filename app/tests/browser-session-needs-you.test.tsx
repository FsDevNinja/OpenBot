import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useNeedsYou } from "@/components/computer/needs-you";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("slow control reads do not overlap and a remounted human takeover stays live", async () => {
  let resolveRead!: (response: Response) => void;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveRead = resolve;
      }),
  );
  try {
    const hook = renderHook(() => useNeedsYou("slow-control", true, true));
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveRead(
      new Response(JSON.stringify({ holder: "human", requested: false })),
    );
    await waitFor(() => expect(hook.result.current).toBe(true));
  } finally {
    cleanup();
    fetchSpy.mockRestore();
  }
});

test("a failed poll does not clear a pending help request", async () => {
  let calls = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ holder: "bot", requested: true }))
      : new Response("unavailable", { status: 503 });
  });
  try {
    const hook = renderHook(() => useNeedsYou("transient-control", true));
    await waitFor(() => expect(hook.result.current).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(calls).toBe(2);
    expect(hook.result.current).toBe(true);
  } finally {
    cleanup();
    fetchSpy.mockRestore();
  }
});
