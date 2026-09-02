import { describe, expect, test } from "bun:test";
import { createProviderOAuthBroker } from "../src/agents/provider-oauth";
import { AGENT_PROVIDER_CATALOG } from "../src/agents/providers";

const runtime = {
  ...AGENT_PROVIDER_CATALOG[0],
  endpoint: new URL("https://runtime.example.test/ag-ui"),
  token: "managed-runtime-token",
};

describe("provider OAuth broker", () => {
  test("starts and checks OAuth only through the authenticated provider runtime", async () => {
    const requests: Request[] = [];
    const broker = createProviderOAuthBroker([runtime], async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname === "/auth/login/start") {
        return Response.json({
          loginId: "login-id",
          verificationUrl: "https://auth.openai.test/device",
          userCode: "ABCD-1234",
        });
      }
      return Response.json({ status: "connected" });
    });

    await expect(
      broker.start("codex", "b72a64ed-1f58-4b10-91e7-fb00aa0975bf"),
    ).resolves.toMatchObject({ loginId: "login-id" });
    await expect(
      broker.status(
        "codex",
        "b72a64ed-1f58-4b10-91e7-fb00aa0975bf",
        "login-id",
      ),
    ).resolves.toEqual({ status: "connected" });

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/auth/login/start",
      "/auth/login/status",
    ]);
    expect(
      requests.every(
        (request) =>
          request.headers.get("x-openbot-agent-token") ===
          "managed-runtime-token",
      ),
    ).toBe(true);
  });
});
