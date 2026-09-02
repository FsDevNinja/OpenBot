import { z } from "zod";
import type { RunAssertion } from "../agents/callback-token";
import type { GrantedTool } from "../plugins/tools";
import type { CloudAgentTaskService } from "./service";
import type { CloudAgentTask } from "./store";

export const DELEGATE_DEVELOPMENT_TOOL = "delegate_development_task";
export const LIST_DEVELOPMENT_MODELS_TOOL = "list_development_models";
export const UPDATE_DEVELOPMENT_TOOL = "update_development_task";
export const CANCEL_DEVELOPMENT_TOOL = "cancel_development_task";
export const GET_DEVELOPMENT_TOOL = "get_development_task";

export const CLOUD_DEVELOPMENT_TOOL_NAMES = new Set([
  DELEGATE_DEVELOPMENT_TOOL,
  LIST_DEVELOPMENT_MODELS_TOOL,
  UPDATE_DEVELOPMENT_TOOL,
  CANCEL_DEVELOPMENT_TOOL,
  GET_DEVELOPMENT_TOOL,
]);

function taskResult(task: CloudAgentTask) {
  return JSON.stringify({
    taskId: task.id,
    provider: task.provider,
    title: task.title,
    repositoryUrl: task.repositoryUrl,
    model: task.model,
    status: task.status,
    remoteUrl: task.remoteUrl,
    branch: task.branch,
    pullRequestUrl: task.pullRequestUrl,
    result: task.result,
    error: task.lastError,
  });
}

const taskId = z
  .string()
  .uuid()
  .describe(
    "The OpenBot cloud development task ID returned when the task was started",
  );

export function cloudDevelopmentTools(options: {
  service: CloudAgentTaskService;
  run: RunAssertion;
}): GrantedTool[] {
  const { service, run } = options;
  const modelParameters = z.object({
    id: z
      .string()
      .describe("A parameter ID returned by list_development_models"),
    value: z
      .string()
      .describe("A supported value returned for that model parameter"),
  });
  const startParameters = z.object({
    title: z
      .string()
      .describe("A short, specific name for the development task"),
    repositoryUrl: z
      .string()
      .url()
      .describe("The HTTPS GitHub repository URL Cursor should work in"),
    startingRef: z
      .string()
      .optional()
      .describe(
        "The branch or commit to start from; omit to use the repository default",
      ),
    model: z
      .object({
        id: z
          .string()
          .describe(
            "An exact Cursor model ID returned by list_development_models",
          ),
        params: z
          .array(modelParameters)
          .max(16)
          .optional()
          .describe(
            "Optional supported model parameters, such as effort or fast mode",
          ),
      })
      .optional()
      .describe(
        "An explicit Cursor model selection. Only set this when the person requested a model or model options; otherwise omit it to use their Cursor default.",
      ),
    instruction: z
      .string()
      .describe(
        "The complete implementation brief, including constraints and how to verify the work",
      ),
  });
  const listParameters = z.object({});
  const updateParameters = z.object({
    taskId,
    instruction: z
      .string()
      .describe(
        "The follow-up instruction for the same Cursor agent and workspace",
      ),
  });
  const taskParameters = z.object({ taskId });

  return [
    {
      name: DELEGATE_DEVELOPMENT_TOOL,
      ref: `cloud-agent/${DELEGATE_DEVELOPMENT_TOOL}`,
      description:
        "Delegate substantial repository implementation work to a Cursor Cloud Agent. Use it for coding, tests, or repository investigation that should happen in an isolated cloud workspace. Cursor always works on a separate branch and may open a pull request; it never merges or deploys. If the person explicitly requests a model, call list_development_models first and pass its exact model ID and supported parameters. Otherwise omit model to use the person's Cursor default. Do not choose costly fast or effort options the person did not request. Do not use this for a quick answer you can provide directly.",
      parameters: startParameters,
      execute: async (args) => {
        const parsed = startParameters.safeParse(args);
        if (!parsed.success) {
          return "The cloud development task was not started: provide a title, GitHub repository URL, and complete instruction.";
        }
        if (!run.threadId) {
          return "The cloud development task was not started because this run has no conversation to report progress into.";
        }
        return taskResult(
          await service.start({
            actorId: run.actorId,
            botId: run.botId,
            threadId: run.threadId,
            runId: run.runId,
            ...parsed.data,
          }),
        );
      },
    },
    {
      name: LIST_DEVELOPMENT_MODELS_TOOL,
      ref: `cloud-agent/${LIST_DEVELOPMENT_MODELS_TOOL}`,
      description:
        "List the Cursor Cloud Agent models and parameter values currently available through this person's Cursor connection. Use this before starting a cloud development task when the person asks for a specific model, effort level, or fast mode.",
      parameters: listParameters,
      execute: async (args) => {
        const parsed = listParameters.safeParse(args);
        if (!parsed.success) {
          return "The cloud development models could not be listed: no arguments are accepted.";
        }
        return JSON.stringify({
          provider: "cursor",
          models: (await service.listModels(run.actorId)).map((model) => ({
            id: model.id,
            displayName: model.displayName,
            ...(model.description ? { description: model.description } : {}),
            parameters: model.parameters,
          })),
        });
      },
    },
    {
      name: UPDATE_DEVELOPMENT_TOOL,
      ref: `cloud-agent/${UPDATE_DEVELOPMENT_TOOL}`,
      description:
        "Send a follow-up instruction to a completed Cursor Cloud Agent task, preserving its conversation and workspace. If it is still running, check its status or cancel it instead.",
      parameters: updateParameters,
      execute: async (args) => {
        const parsed = updateParameters.safeParse(args);
        if (!parsed.success) {
          return "The cloud development task was not updated: provide its task ID and a follow-up instruction.";
        }
        return taskResult(
          await service.update(
            run.actorId,
            parsed.data.taskId,
            parsed.data.instruction,
          ),
        );
      },
    },
    {
      name: CANCEL_DEVELOPMENT_TOOL,
      ref: `cloud-agent/${CANCEL_DEVELOPMENT_TOOL}`,
      description:
        "Cancel the active run of a Cursor Cloud Agent task. Cancellation is terminal for that run, but the same durable task can later receive a follow-up instruction.",
      parameters: taskParameters,
      execute: async (args) => {
        const parsed = taskParameters.safeParse(args);
        if (!parsed.success) {
          return "The cloud development task was not cancelled: provide its task ID.";
        }
        return taskResult(
          await service.cancel(run.actorId, parsed.data.taskId),
        );
      },
    },
    {
      name: GET_DEVELOPMENT_TOOL,
      ref: `cloud-agent/${GET_DEVELOPMENT_TOOL}`,
      description:
        "Get the latest durable status, result, branch, and pull request for a cloud development task.",
      parameters: taskParameters,
      execute: async (args) => {
        const parsed = taskParameters.safeParse(args);
        if (!parsed.success) {
          return "The cloud development task could not be checked: provide its task ID.";
        }
        return taskResult(await service.get(run.actorId, parsed.data.taskId));
      },
    },
  ];
}
