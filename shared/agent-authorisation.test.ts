import { describe, expect, test } from "bun:test";
import {
  hasManagedAgentToken,
  matchesToken,
  providerConnectionFrom,
  providerCredentialFrom,
  providerTypeFrom,
} from "./agent-authorisation";

describe("managed agent authorization", () => {
  test("accepts only the configured token", () => {
    const expected = "agent-bot-secret";

    expect(
      hasManagedAgentToken(
        new Request("http://bot.local/ag-ui", {
          headers: { "x-openbot-agent-token": expected },
        }),
        expected,
      ),
    ).toBe(true);
    expect(
      hasManagedAgentToken(new Request("http://bot.local/ag-ui"), expected),
    ).toBe(false);
    expect(
      hasManagedAgentToken(
        new Request("http://bot.local/ag-ui", {
          headers: { "x-openbot-agent-token": "wrong" },
        }),
        expected,
      ),
    ).toBe(false);
  });

  test("rejects empty and differently sized tokens", () => {
    expect(matchesToken("", "")).toBe(false);
    expect(matchesToken("expected", "short")).toBe(false);
  });
});

describe("personal provider authorization", () => {
  test("reads the provider type and key from server-only runtime headers", () => {
    const request = new Request("http://bot.local/ag-ui", {
      headers: {
        "x-openbot-provider-type": " Anthropic ",
        "x-openbot-provider-credential": " user-secret ",
        "x-openbot-provider-connection": " connection-id ",
      },
    });

    expect(providerTypeFrom(request)).toBe("anthropic");
    expect(providerCredentialFrom(request)).toBe("user-secret");
    expect(providerConnectionFrom(request)).toBe("connection-id");
  });

  test("does not invent a deployment fallback when the runner sent no key", () => {
    const request = new Request("http://bot.local/ag-ui");

    expect(providerTypeFrom(request)).toBe("");
    expect(providerCredentialFrom(request)).toBe("");
    expect(providerConnectionFrom(request)).toBe("");
  });
});
