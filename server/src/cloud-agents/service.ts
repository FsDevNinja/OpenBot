import { randomUUID } from "node:crypto";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { CloudAgentConnectionStore } from "./connections";
import {
  CursorApiError,
  type CursorClient,
  type CursorModel,
  type CursorModelSelection,
} from "./cursor-client";
import {
  type CloudAgentModelSelection,
  type CloudAgentTask,
  type CloudAgentTaskStore,
  isTerminalCloudAgentTask,
} from "./store";

const GITHUB_REPOSITORY =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CloudAgentTaskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAgentTaskInputError";
  }
}

export type CloudAgentTaskService = {
  start(input: {
    actorId: string;
    botId: string;
    threadId: string;
    runId: string;
    title: string;
    repositoryUrl: string;
    startingRef?: string;
    model?: CursorModelSelection;
    instruction: string;
  }): Promise<CloudAgentTask>;
  listModels(actorId: string): Promise<CursorModel[]>;
  get(
    actorId: string,
    taskId: string,
    refresh?: boolean,
  ): Promise<CloudAgentTask>;
  update(
    actorId: string,
    taskId: string,
    instruction: string,
  ): Promise<CloudAgentTask>;
  cancel(actorId: string, taskId: string): Promise<CloudAgentTask>;
  refresh(taskId: string, actorId?: string): Promise<CloudAgentTask | null>;
  sweep(): Promise<number>;
};

function clean(value: string, name: string, maximum: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CloudAgentTaskInputError(`${name} is required.`);
  if (trimmed.length > maximum) {
    throw new CloudAgentTaskInputError(
      `${name} must be ${maximum} characters or fewer.`,
    );
  }
  return trimmed;
}

function errorMessage(error: unknown): string {
  if (error instanceof CursorApiError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Cursor did not answer before the request timed out.";
  }
  return error instanceof Error
    ? error.message
    : "Cursor could not be reached.";
}

function uncertain(error: unknown): boolean {
  return (
    !(error instanceof CursorApiError) ||
    error.status >= 500 ||
    error.status === 409
  );
}

function latestRun(task: CloudAgentTask) {
  return task.runs.at(-1) ?? null;
}

function resolveModelSelection(
  requested: CursorModelSelection,
  available: CursorModel[],
): CloudAgentModelSelection {
  const requestedId = clean(requested.id, "Model ID", 200);
  const model = available.find(
    (candidate) =>
      candidate.id === requestedId || candidate.aliases.includes(requestedId),
  );
  if (!model) {
    throw new CloudAgentTaskInputError(
      `Model ${requestedId} is not available for your Cursor connection. Check the current model list before starting the task.`,
    );
  }

  const requestedParams = requested.params ?? [];
  if (requestedParams.length > 16) {
    throw new CloudAgentTaskInputError(
      "A cloud development model can have at most 16 parameters.",
    );
  }
  const seen = new Set<string>();
  const params = requestedParams.map((parameter) => {
    const id = clean(parameter.id, "Model parameter ID", 100);
    const value = clean(parameter.value, "Model parameter value", 100);
    if (seen.has(id)) {
      throw new CloudAgentTaskInputError(
        `Model parameter ${id} was provided more than once.`,
      );
    }
    seen.add(id);
    const definition = model.parameters.find(
      (candidate) => candidate.id === id,
    );
    if (!definition) {
      throw new CloudAgentTaskInputError(
        `Model ${model.displayName} does not support parameter ${id}.`,
      );
    }
    if (!definition.values.some((candidate) => candidate.value === value)) {
      throw new CloudAgentTaskInputError(
        `Model ${model.displayName} does not support ${id}=${value}.`,
      );
    }
    return { id, value };
  });

  if (model.variants.length === 0) {
    return { id: model.id, displayName: model.displayName, params };
  }

  let candidates = model.variants.filter((variant) =>
    params.every((requestedParameter) =>
      variant.params.some(
        (variantParameter) =>
          variantParameter.id === requestedParameter.id &&
          variantParameter.value === requestedParameter.value,
      ),
    ),
  );
  if (candidates.length === 0) {
    throw new CloudAgentTaskInputError(
      `Model ${model.displayName} does not support that parameter combination.`,
    );
  }

  const requestedIds = new Set(params.map((parameter) => parameter.id));
  if (!requestedIds.has("fast")) {
    const nonFastCandidates = candidates.filter((variant) =>
      variant.params.some(
        (parameter) => parameter.id === "fast" && parameter.value === "false",
      ),
    );
    if (nonFastCandidates.length > 0) candidates = nonFastCandidates;
  }

  const defaultVariant = model.variants.find((variant) => variant.isDefault);
  const distanceFromDefault = (variant: (typeof candidates)[number]) =>
    variant.params.reduce((distance, parameter) => {
      if (requestedIds.has(parameter.id)) return distance;
      const defaultParameter = defaultVariant?.params.find(
        (candidate) => candidate.id === parameter.id,
      );
      return distance + (defaultParameter?.value === parameter.value ? 0 : 1);
    }, 0);
  const variant = candidates.reduce((preferred, candidate) => {
    const candidateDistance = distanceFromDefault(candidate);
    const preferredDistance = distanceFromDefault(preferred);
    if (candidateDistance < preferredDistance) return candidate;
    if (
      candidateDistance === preferredDistance &&
      candidate.isDefault &&
      !preferred.isDefault
    ) {
      return candidate;
    }
    return preferred;
  });

  return {
    id: model.id,
    displayName: model.displayName,
    params: variant.params,
  };
}

export function createCloudAgentTaskService(options: {
  store: CloudAgentTaskStore;
  connections: CloudAgentConnectionStore;
  cursor: CursorClient;
  auditStore?: AuditStore;
}): CloudAgentTaskService {
  const { store, connections, cursor, auditStore } = options;

  const requireTask = async (actorId: string, taskId: string) => {
    if (!TASK_ID.test(taskId)) {
      throw new CloudAgentTaskInputError(
        "That cloud development task was not found.",
      );
    }
    const task = await store.get(taskId, actorId);
    if (!task) {
      throw new CloudAgentTaskInputError(
        "That cloud development task was not found.",
      );
    }
    return task;
  };

  const recoverRun = async (
    apiKey: string,
    task: CloudAgentTask,
  ): Promise<CloudAgentTask | null> => {
    try {
      const agent = await cursor.getAgent(apiKey, task.remoteAgentId);
      const run = await cursor.getRun(apiKey, agent.id, agent.latestRunId);
      const local = latestRun(task);
      if (!local || local.sequence === 1) {
        await store.attachCreated({
          taskId: task.id,
          remoteUrl: agent.url,
          run,
        });
      } else {
        await store.attachFollowup(task.id, local.id, run);
      }
      return store.get(task.id, task.ownerUserId);
    } catch (error) {
      if (error instanceof CursorApiError && error.status === 404) return null;
      throw error;
    }
  };

  const refresh = async (
    taskId: string,
    actorId?: string,
  ): Promise<CloudAgentTask | null> => {
    if (!TASK_ID.test(taskId)) {
      throw new CloudAgentTaskInputError(
        "That cloud development task was not found.",
      );
    }
    let task = await store.get(taskId, actorId);
    if (!task) return null;
    if (isTerminalCloudAgentTask(task.status)) return task;
    const apiKey = await connections.apiKeyFor(task.ownerUserId);
    if (!apiKey) return task;

    const run = latestRun(task);
    if (!run?.remoteRunId) {
      const recovered = await recoverRun(apiKey, task).catch(() => null);
      if (recovered) return recovered;
      return task;
    }
    try {
      const remote = await cursor.getRun(
        apiKey,
        task.remoteAgentId,
        run.remoteRunId,
      );
      await store.updateFromRemote(task.id, remote);
      task = (await store.get(task.id, actorId)) ?? task;
    } catch {
      // Tracking is best effort. The durable row remains active and the next sweep tries again.
    }
    return task;
  };

  return {
    async listModels(actorId) {
      const apiKey = await connections.apiKeyFor(actorId);
      if (!apiKey) {
        throw new CloudAgentTaskInputError(
          "Connect Cursor Cloud Agents in Settings before listing development models.",
        );
      }
      return cursor.listModels(apiKey);
    },

    async start(input) {
      const title = clean(input.title, "Title", 100);
      const instruction = clean(input.instruction, "Instruction", 20_000);
      const repositoryUrl = clean(input.repositoryUrl, "Repository URL", 2_000);
      if (!GITHUB_REPOSITORY.test(repositoryUrl)) {
        throw new CloudAgentTaskInputError(
          "Repository URL must be a public GitHub-style HTTPS URL, such as https://github.com/acme/project.",
        );
      }
      const startingRef = input.startingRef?.trim();
      if (startingRef && (startingRef.length > 255 || /\s/.test(startingRef))) {
        throw new CloudAgentTaskInputError("Starting ref is invalid.");
      }
      const apiKey = await connections.apiKeyFor(input.actorId);
      if (!apiKey) {
        throw new CloudAgentTaskInputError(
          "Connect Cursor Cloud Agents in Settings before delegating development work.",
        );
      }
      const model = input.model
        ? resolveModelSelection(input.model, await cursor.listModels(apiKey))
        : undefined;

      const id = randomUUID();
      const remoteAgentId = `bc-${id}`;
      await store.create({
        id,
        ownerUserId: input.actorId,
        requestingAgentId: input.botId,
        threadId: input.threadId,
        originatingRunId: input.runId,
        title,
        repositoryUrl,
        ...(startingRef ? { startingRef } : {}),
        ...(model ? { model } : {}),
        instruction,
        remoteAgentId,
      });

      try {
        const created = await cursor.createAgent(apiKey, {
          agentId: remoteAgentId,
          name: title,
          prompt: instruction,
          repositoryUrl,
          ...(startingRef ? { startingRef } : {}),
          ...(model
            ? {
                model: {
                  id: model.id,
                  ...(model.params.length > 0 ? { params: model.params } : {}),
                },
              }
            : {}),
          autoCreatePR: true,
        });
        await store.attachCreated({
          taskId: id,
          remoteUrl: created.agent.url,
          run: created.run,
        });
      } catch (error) {
        const original = await store.get(id, input.actorId);
        const recovered = original
          ? await recoverRun(apiKey, original).catch(() => null)
          : null;
        if (!recovered) {
          await store.markSubmission({
            taskId: id,
            status: uncertain(error) ? "submission_uncertain" : "failed",
            error: errorMessage(error),
          });
        }
      }

      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "cloud_agent.task_started",
          targetType: "cloud_agent_task",
          targetId: id,
          actorUserId: input.actorId,
          payload: {
            provider: "cursor",
            requestingAgentId: input.botId,
            repositoryUrl,
            remoteAgentId,
            model: model ?? null,
            note: "The remote worker uses the person's Cursor connection and always starts on a separate branch.",
          },
        });
      }
      return requireTask(input.actorId, id);
    },

    async get(actorId, taskId, shouldRefresh = true) {
      const task = shouldRefresh
        ? await refresh(taskId, actorId)
        : await store.get(taskId, actorId);
      if (!task) {
        throw new CloudAgentTaskInputError(
          "That cloud development task was not found.",
        );
      }
      return task;
    },

    async update(actorId, taskId, rawInstruction) {
      const instruction = clean(rawInstruction, "Instruction", 20_000);
      let task = await this.get(actorId, taskId, true);
      if (!isTerminalCloudAgentTask(task.status)) {
        throw new CloudAgentTaskInputError(
          "That cloud development task is still running. Wait for it to finish or cancel it first.",
        );
      }
      const apiKey = await connections.apiKeyFor(actorId);
      if (!apiKey) {
        throw new CloudAgentTaskInputError(
          "Reconnect Cursor Cloud Agents in Settings before updating this task.",
        );
      }
      const localRunId = await store.beginFollowup(
        taskId,
        actorId,
        instruction,
      );
      try {
        const run = await cursor.createRun(
          apiKey,
          task.remoteAgentId,
          instruction,
        );
        await store.attachFollowup(taskId, localRunId, run);
      } catch (error) {
        await store.failFollowup(
          taskId,
          localRunId,
          errorMessage(error),
          uncertain(error) ? "submission_uncertain" : "failed",
        );
      }
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "cloud_agent.task_updated",
          targetType: "cloud_agent_task",
          targetId: taskId,
          actorUserId: actorId,
          payload: { provider: "cursor" },
        });
      }
      task = await requireTask(actorId, taskId);
      return task;
    },

    async cancel(actorId, taskId) {
      const task = await this.get(actorId, taskId, true);
      const run = latestRun(task);
      if (isTerminalCloudAgentTask(task.status)) return task;
      if (!run?.remoteRunId) {
        throw new CloudAgentTaskInputError(
          "Cursor has not acknowledged this task yet, so it cannot be cancelled safely.",
        );
      }
      const apiKey = await connections.apiKeyFor(actorId);
      if (!apiKey) {
        throw new CloudAgentTaskInputError(
          "Reconnect Cursor Cloud Agents in Settings before cancelling this task.",
        );
      }
      try {
        await cursor.cancelRun(apiKey, task.remoteAgentId, run.remoteRunId);
      } catch (error) {
        if (!(error instanceof CursorApiError && error.status === 409))
          throw error;
      }
      const remote = await cursor
        .getRun(apiKey, task.remoteAgentId, run.remoteRunId)
        .catch(() => ({
          id: run.remoteRunId as string,
          agentId: task.remoteAgentId,
          status: "CANCELLED",
        }));
      await store.updateFromRemote(taskId, remote);
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "cloud_agent.task_cancelled",
          targetType: "cloud_agent_task",
          targetId: taskId,
          actorUserId: actorId,
          payload: { provider: "cursor", remoteRunId: run.remoteRunId },
        });
      }
      return requireTask(actorId, taskId);
    },

    refresh,

    async sweep() {
      const tasks = await store.active();
      await Promise.allSettled(
        tasks.map((task) => refresh(task.id, task.ownerUserId)),
      );
      return tasks.length;
    },
  };
}

export type CloudAgentTracker = { stop(): void };

export function startCloudAgentTracker(
  service: Pick<CloudAgentTaskService, "sweep">,
  intervalMs = 10_000,
): CloudAgentTracker {
  let sweeping = false;
  const sweep = () => {
    if (sweeping) return;
    sweeping = true;
    void service
      .sweep()
      .catch((error) =>
        console.warn(
          "[cloud-agents] progress could not be refreshed:",
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        sweeping = false;
      });
  };
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  sweep();
  return { stop: () => clearInterval(timer) };
}
