import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  CloudAgentTaskInputError,
  type CloudAgentTaskService,
} from "./service";

export function createCloudAgentTaskRoutes(
  service: CloudAgentTaskService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:taskId", requireUser, async (context) => {
    try {
      return context.json({
        task: await service.get(
          context.var.actor.id,
          context.req.param("taskId"),
        ),
      });
    } catch (error) {
      return mapError(context, error);
    }
  });

  routes.post("/:taskId/cancel", requireUser, async (context) => {
    try {
      return context.json({
        task: await service.cancel(
          context.var.actor.id,
          context.req.param("taskId"),
        ),
      });
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
  if (error instanceof CloudAgentTaskInputError) {
    const status = error.message.includes("not found") ? 404 : 400;
    return context.json({ error: error.message }, status);
  }
  throw error;
}
