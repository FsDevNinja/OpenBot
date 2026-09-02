import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  InvalidProviderCredentialError,
  type ProviderConnectionStore,
  UnknownProviderTypeError,
} from "./provider-connections";
import { ProviderOAuthUnavailableError } from "./provider-oauth";
import { isAgentProviderId } from "./providers";

export function createProviderConnectionRoutes(
  store: ProviderConnectionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) =>
    context.json({ providers: await store.statuses(context.var.actor) }),
  );

  routes.put(
    "/:providerId",
    requireUser,
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) =>
        context.json(
          { error: "Provider credentials must be 16 KB or smaller." },
          413,
        ),
    }),
    async (context) => {
      const providerId = context.req.param("providerId");
      if (!isAgentProviderId(providerId)) {
        return context.json({ error: "Provider type not found." }, 404);
      }
      const body = (await context.req.json().catch(() => ({}))) as {
        credential?: unknown;
      };
      try {
        const provider = await store.connect(
          context.var.actor,
          providerId,
          typeof body.credential === "string" ? body.credential : undefined,
        );
        return context.json({ provider });
      } catch (error) {
        return mapConnectionError(context, error);
      }
    },
  );

  routes.post("/:providerId/oauth/start", requireUser, async (context) => {
    const providerId = context.req.param("providerId");
    if (!isAgentProviderId(providerId)) {
      return context.json({ error: "Provider type not found." }, 404);
    }
    try {
      return context.json({
        authorization: await store.startOAuth(context.var.actor, providerId),
      });
    } catch (error) {
      return mapConnectionError(context, error);
    }
  });

  routes.get("/:providerId/oauth/:sessionId", requireUser, async (context) => {
    const providerId = context.req.param("providerId");
    if (!isAgentProviderId(providerId)) {
      return context.json({ error: "Provider type not found." }, 404);
    }
    try {
      return context.json({
        authorization: await store.oauthStatus(
          context.var.actor,
          providerId,
          context.req.param("sessionId"),
        ),
      });
    } catch (error) {
      return mapConnectionError(context, error);
    }
  });

  routes.delete(
    "/:providerId/oauth/:sessionId",
    requireUser,
    async (context) => {
      const providerId = context.req.param("providerId");
      if (!isAgentProviderId(providerId)) {
        return context.json({ error: "Provider type not found." }, 404);
      }
      try {
        await store.cancelOAuth(
          context.var.actor,
          providerId,
          context.req.param("sessionId"),
        );
        return context.body(null, 204);
      } catch (error) {
        return mapConnectionError(context, error);
      }
    },
  );

  routes.delete("/:providerId", requireUser, async (context) => {
    const providerId = context.req.param("providerId");
    if (!isAgentProviderId(providerId)) {
      return context.json({ error: "Provider type not found." }, 404);
    }
    try {
      await store.disconnect(context.var.actor, providerId);
      return context.body(null, 204);
    } catch (error) {
      return mapConnectionError(context, error);
    }
  });

  return routes;
}

function mapConnectionError(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
): Response {
  if (error instanceof UnknownProviderTypeError) {
    return context.json({ error: "Provider type not found." }, 404);
  }
  if (error instanceof InvalidProviderCredentialError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof ProviderOAuthUnavailableError) {
    return context.json({ error: error.message }, 502);
  }
  throw error;
}
