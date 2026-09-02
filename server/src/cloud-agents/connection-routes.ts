import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  type CloudAgentConnectionStore,
  InvalidCloudAgentCredentialError,
} from "./connections";

export function createCloudAgentConnectionRoutes(
  store: CloudAgentConnectionStore,
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
      const body = (await context.req.json().catch(() => ({}))) as {
        credential?: unknown;
      };
      try {
        return context.json({
          provider: await store.connect(
            context.var.actor,
            context.req.param("providerId"),
            typeof body.credential === "string" ? body.credential : "",
          ),
        });
      } catch (error) {
        return mapError(context, error);
      }
    },
  );

  routes.delete("/:providerId", requireUser, async (context) => {
    try {
      await store.disconnect(
        context.var.actor,
        context.req.param("providerId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapError(context, error);
    }
  });

  return routes;
}

function mapError(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
): Response {
  if (error instanceof InvalidCloudAgentCredentialError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
