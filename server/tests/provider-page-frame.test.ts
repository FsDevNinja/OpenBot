import { describe, expect, test } from "bun:test";
import { captureProviderPageFrame } from "../src/computer/capture-page-frame";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PageFrameStore } from "../src/computer/page-frames";
import { createApp } from "../src/app";
import { mintRunAssertion } from "../src/agents/callback-token";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

function harness(
  options: {
    url?: string;
    isolation?: "shared" | "per-bot";
    state?: string;
    fail?: boolean;
  } = {},
) {
  const saved: Parameters<PageFrameStore["save"]>[0][] = [];
  let screenshots = 0;
  const gateway = {
    provider: { isolation: options.isolation ?? "per-bot" },
    status: async () => ({ state: options.state ?? "ready" }),
    screenshot: async () => {
      screenshots++;
      if (options.fail) throw new Error("Unavailable");
      return { base64: "PNG", url: options.url };
    },
  } as unknown as ComputerGateway;
  const store = {
    save: async (frame) => {
      saved.push(frame);
    },
  } as PageFrameStore;
  return { gateway, store, saved, screenshots: () => screenshots };
}

describe("provider browser frame capture", () => {
  test("callback returns a durable frame reference from the signed bot, not model arguments", async () => {
    const h = harness({ url: "https://example.com/" });
    h.gateway.navigate = async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "Example",
      elapsedMs: 1,
      truncated: false,
    });
    const config = loadConfig(
      testEnvironment({ AGENT_TOOL_TOKEN: "agent-secret" }),
    );
    const dependencies: Parameters<typeof createApp> = [config];
    dependencies[7] = h.gateway;
    dependencies[20] = h.store;
    const app = createApp(...dependencies);
    const run = mintRunAssertion(
      {
        botId: "signed-bot",
        actorId: "local-development",
        runId: "browser-test",
      },
      config.keyEncryptionKey,
    );
    const response = await app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": "agent-secret",
      },
      body: JSON.stringify({
        name: "openbot_computer_navigate",
        args: {
          url: "https://example.com/",
          botId: "other-bot",
          frameId: "overwrite-history",
        },
        run,
      }),
    });
    const result = JSON.parse(
      ((await response.json()) as { text: string }).text,
    );
    expect(result.pageFrame.id).toBe(h.saved[0].toolCallId);
    expect(h.saved[0].computerId).toBe("signed-bot");
    expect(result.pageFrame.id).not.toBe("overwrite-history");
    expect(result.ok).toBe(true);
  });
  test("captures after the action, under a unique identity scoped to the authenticated bot", async () => {
    const h = harness({ url: "https://example.com/final" });
    const a = await captureProviderPageFrame(h.gateway, h.store, "bot-a");
    const b = await captureProviderPageFrame(h.gateway, h.store, "bot-b");
    expect(a?.id).not.toBe(b?.id);
    expect(h.saved[0]).toMatchObject({
      computerId: "bot-a",
      toolCallId: a?.id,
      url: "https://example.com/final",
      frame: "PNG",
    });
    expect(h.saved[1].computerId).toBe("bot-b");
  });
  test("never resumes an idle computer for a preview", async () => {
    const h = harness({ state: "suspended" });
    expect(
      await captureProviderPageFrame(h.gateway, h.store, "bot"),
    ).toBeUndefined();
    expect(h.screenshots()).toBe(0);
  });
  test("declines missing, blank, mismatched and unidentified shared pages", async () => {
    for (const options of [
      {},
      { url: "about:blank" },
      { url: "https://other.test" },
      { isolation: "shared" as const },
    ]) {
      const h = harness(options);
      const page = options.isolation
        ? { url: "https://example.com" }
        : options.url === "https://other.test"
          ? { url: "https://example.com" }
          : undefined;
      expect(
        await captureProviderPageFrame(h.gateway, h.store, "bot", page),
      ).toBeUndefined();
      expect(h.saved).toHaveLength(0);
    }
    const shared = harness({ isolation: "shared", url: "https://example.com" });
    expect(
      await captureProviderPageFrame(shared.gateway, shared.store, "bot"),
    ).toBeUndefined();
  });
  test("supports legacy per-bot images with a known navigation URL", async () => {
    const h = harness();
    expect(
      await captureProviderPageFrame(h.gateway, h.store, "bot", {
        url: "https://example.com",
        title: "Example",
      }),
    ).toMatchObject({ url: "https://example.com", title: "Example" });
  });
  test("unavailable capture or storage does not fail the action", async () => {
    const h = harness({ fail: true });
    expect(
      await captureProviderPageFrame(h.gateway, h.store, "bot"),
    ).toBeUndefined();
    expect(
      await captureProviderPageFrame(h.gateway, undefined, "bot"),
    ).toBeUndefined();
  });
});
