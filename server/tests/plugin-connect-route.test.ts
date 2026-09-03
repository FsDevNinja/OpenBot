import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { ManagedConnectorError } from "../src/plugins/managed-connector";
import { createPluginRoutes } from "../src/plugins/routes";
import { CatalogueEntryUnknownError } from "../src/plugins/store";

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

function app(
  beginManagedConnection: (input: {
    serverId: string;
    userId: string;
    callbackUrl: string;
  }) => Promise<{ connectionId: string; authorizationUrl: string }>,
) {
  const routes = createPluginRoutes(
    { beginManagedConnection } as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: ENCRYPTION_KEY,
      personHasAccess: async () => true,
    },
  );
  return new Hono().route("/api/plugins", routes);
}

describe("connecting a managed per-person connector", () => {
  test("delegates consent to Composio with the stable user id and an OpenBot return URL", async () => {
    const calls: {
      serverId: string;
      userId: string;
      callbackUrl: string;
    }[] = [];
    const hono = app(async (input) => {
      calls.push(input);
      return {
        connectionId: "conn-1",
        authorizationUrl: "https://connect.composio.dev/link-1",
      };
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connectionId: "conn-1",
      authorizationUrl: "https://connect.composio.dev/link-1",
    });
    expect(calls).toEqual([
      {
        serverId: "notion",
        userId: "user-1",
        callbackUrl: "https://app.example/settings/connected-accounts/notion",
      },
    ]);
  });

  test("returns to the admin connector page when consent started there", async () => {
    const callbacks: string[] = [];
    const hono = app(async (input) => {
      callbacks.push(input.callbackUrl);
      return {
        connectionId: "conn-1",
        authorizationUrl: "https://connect.composio.dev/link-1",
      };
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/google-drive/connect?returnTo=admin",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(callbacks).toEqual([
      "https://app.example/admin/plugins/google-drive",
    ]);
  });

  test("reports an unavailable managed backend without provisioning a local OAuth client", async () => {
    const hono = app(async () => {
      throw new ManagedConnectorError(
        "Notion uses managed connections, but Composio is not configured.",
      );
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Notion uses managed connections, but Composio is not configured.",
    });
  });

  test("says when the connector has not been enabled", async () => {
    const hono = app(async (input) => {
      throw new CatalogueEntryUnknownError(input.serverId);
    });

    const response = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "Notion has not been enabled for this deployment yet. An administrator has to enable it first.",
    });
  });
});
