import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { cloudAgentTaskRuns, cloudAgentTasks } from "../db/schema";
import type { CursorRun } from "./cursor-client";

export type CloudAgentModelSelection = {
  id: string;
  displayName: string;
  params: Array<{ id: string; value: string }>;
};

export type CloudAgentTaskStatus =
  | "submitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "submission_uncertain";

export type CloudAgentRunRecord = {
  id: string;
  sequence: number;
  instruction: string;
  remoteRunId: string | null;
  status: CloudAgentTaskStatus;
  result: string | null;
  durationMs: number | null;
  git: Record<string, unknown>;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

export type CloudAgentTask = {
  id: string;
  ownerUserId: string;
  requestingAgentId: string;
  threadId: string;
  originatingRunId: string;
  provider: "cursor";
  title: string;
  repositoryUrl: string;
  startingRef: string | null;
  model: CloudAgentModelSelection | null;
  initialInstruction: string;
  status: CloudAgentTaskStatus;
  remoteAgentId: string;
  remoteUrl: string | null;
  result: string | null;
  branch: string | null;
  pullRequestUrl: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  runs: CloudAgentRunRecord[];
};

const ACTIVE: CloudAgentTaskStatus[] = [
  "submitting",
  "queued",
  "running",
  "submission_uncertain",
];

function statusFromCursor(status: string): CloudAgentTaskStatus {
  switch (status.toUpperCase()) {
    case "CREATING":
      return "queued";
    case "RUNNING":
      return "running";
    case "FINISHED":
      return "succeeded";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    case "ERROR":
      return "failed";
    default:
      return "running";
  }
}

function isTerminal(status: CloudAgentTaskStatus) {
  return !ACTIVE.includes(status);
}

function gitSummary(run: CursorRun) {
  const branches = run.git?.branches ?? [];
  const last = branches.at(-1);
  return {
    git: { branches },
    branch: last?.branch ?? null,
    pullRequestUrl: last?.prUrl ?? null,
  };
}

export type CloudAgentTaskStore = {
  create(input: {
    id: string;
    ownerUserId: string;
    requestingAgentId: string;
    threadId: string;
    originatingRunId: string;
    title: string;
    repositoryUrl: string;
    startingRef?: string;
    model?: CloudAgentModelSelection;
    instruction: string;
    remoteAgentId: string;
  }): Promise<void>;
  attachCreated(input: {
    taskId: string;
    remoteUrl: string;
    run: CursorRun;
  }): Promise<void>;
  markSubmission(input: {
    taskId: string;
    status: "failed" | "submission_uncertain";
    error: string;
  }): Promise<void>;
  get(taskId: string, ownerUserId?: string): Promise<CloudAgentTask | null>;
  active(limit?: number): Promise<Array<{ id: string; ownerUserId: string }>>;
  updateFromRemote(taskId: string, run: CursorRun): Promise<void>;
  beginFollowup(
    taskId: string,
    ownerUserId: string,
    instruction: string,
  ): Promise<string>;
  attachFollowup(taskId: string, runId: string, run: CursorRun): Promise<void>;
  failFollowup(
    taskId: string,
    runId: string,
    error: string,
    status?: "failed" | "submission_uncertain",
  ): Promise<void>;
};

export function createCloudAgentTaskStore(
  database: Database,
): CloudAgentTaskStore {
  const get = async (
    taskId: string,
    ownerUserId?: string,
  ): Promise<CloudAgentTask | null> => {
    const [task] = await database
      .select()
      .from(cloudAgentTasks)
      .where(
        ownerUserId
          ? and(
              eq(cloudAgentTasks.id, taskId),
              eq(cloudAgentTasks.ownerUserId, ownerUserId),
            )
          : eq(cloudAgentTasks.id, taskId),
      )
      .limit(1);
    if (!task) return null;
    const runs = await database
      .select()
      .from(cloudAgentTaskRuns)
      .where(eq(cloudAgentTaskRuns.taskId, task.id))
      .orderBy(asc(cloudAgentTaskRuns.sequence));
    return {
      ...task,
      model: task.model ? (task.model as CloudAgentModelSelection) : null,
      provider: "cursor",
      status: task.status as CloudAgentTaskStatus,
      runs: runs.map((run) => ({
        ...run,
        status: run.status as CloudAgentTaskStatus,
        git: run.git as Record<string, unknown>,
      })),
    };
  };

  return {
    async create(input) {
      await database.transaction(async (transaction) => {
        await transaction.insert(cloudAgentTasks).values({
          id: input.id,
          ownerUserId: input.ownerUserId,
          requestingAgentId: input.requestingAgentId,
          threadId: input.threadId,
          originatingRunId: input.originatingRunId,
          provider: "cursor",
          title: input.title,
          repositoryUrl: input.repositoryUrl,
          ...(input.startingRef ? { startingRef: input.startingRef } : {}),
          ...(input.model ? { model: input.model } : {}),
          initialInstruction: input.instruction,
          status: "submitting",
          remoteAgentId: input.remoteAgentId,
        });
        await transaction.insert(cloudAgentTaskRuns).values({
          taskId: input.id,
          sequence: 1,
          instruction: input.instruction,
          status: "submitting",
        });
      });
    },

    async attachCreated({ taskId, remoteUrl, run }) {
      const status = statusFromCursor(run.status);
      const now = new Date();
      const git = gitSummary(run);
      const lastError =
        status === "failed"
          ? (run.result ?? "Cursor reported an error.")
          : null;
      await database.transaction(async (transaction) => {
        await transaction
          .update(cloudAgentTasks)
          .set({
            remoteUrl,
            status,
            result: run.result ?? null,
            branch: git.branch,
            pullRequestUrl: git.pullRequestUrl,
            lastError,
            updatedAt: now,
            ...(isTerminal(status) ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTasks.id, taskId));
        await transaction
          .update(cloudAgentTaskRuns)
          .set({
            remoteRunId: run.id,
            status,
            result: run.result ?? null,
            durationMs: run.durationMs ?? null,
            git: git.git,
            lastError,
            updatedAt: now,
            ...(isTerminal(status) ? { finishedAt: now } : {}),
          })
          .where(
            and(
              eq(cloudAgentTaskRuns.taskId, taskId),
              eq(cloudAgentTaskRuns.sequence, 1),
            ),
          );
      });
    },

    async markSubmission({ taskId, status, error }) {
      const now = new Date();
      await database.transaction(async (transaction) => {
        await transaction
          .update(cloudAgentTasks)
          .set({
            status,
            lastError: error,
            updatedAt: now,
            ...(status === "failed" ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTasks.id, taskId));
        await transaction
          .update(cloudAgentTaskRuns)
          .set({
            status,
            lastError: error,
            updatedAt: now,
            ...(status === "failed" ? { finishedAt: now } : {}),
          })
          .where(
            and(
              eq(cloudAgentTaskRuns.taskId, taskId),
              eq(cloudAgentTaskRuns.sequence, 1),
            ),
          );
      });
    },

    get,

    async active(limit = 100) {
      return database
        .select({
          id: cloudAgentTasks.id,
          ownerUserId: cloudAgentTasks.ownerUserId,
        })
        .from(cloudAgentTasks)
        .where(inArray(cloudAgentTasks.status, ACTIVE))
        .orderBy(asc(cloudAgentTasks.updatedAt))
        .limit(limit);
    },

    async updateFromRemote(taskId, run) {
      const status = statusFromCursor(run.status);
      const now = new Date();
      const git = gitSummary(run);
      await database.transaction(async (transaction) => {
        await transaction
          .update(cloudAgentTaskRuns)
          .set({
            status,
            result: run.result ?? null,
            durationMs: run.durationMs ?? null,
            git: git.git,
            lastError:
              status === "failed"
                ? (run.result ?? "Cursor reported an error.")
                : null,
            updatedAt: now,
            ...(isTerminal(status) ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTaskRuns.remoteRunId, run.id));
        await transaction
          .update(cloudAgentTasks)
          .set({
            status,
            result: run.result ?? null,
            branch: git.branch,
            pullRequestUrl: git.pullRequestUrl,
            lastError:
              status === "failed"
                ? (run.result ?? "Cursor reported an error.")
                : null,
            updatedAt: now,
            ...(isTerminal(status)
              ? { finishedAt: now }
              : { finishedAt: null }),
          })
          .where(eq(cloudAgentTasks.id, taskId));
      });
    },

    async beginFollowup(taskId, ownerUserId, instruction) {
      return database.transaction(async (transaction) => {
        const [task] = await transaction
          .select({ status: cloudAgentTasks.status })
          .from(cloudAgentTasks)
          .where(
            and(
              eq(cloudAgentTasks.id, taskId),
              eq(cloudAgentTasks.ownerUserId, ownerUserId),
            ),
          )
          .for("update");
        if (!task)
          throw new Error("That cloud development task was not found.");
        if (ACTIVE.includes(task.status as CloudAgentTaskStatus)) {
          throw new Error("That cloud development task is still running.");
        }
        const [latest] = await transaction
          .select({ sequence: cloudAgentTaskRuns.sequence })
          .from(cloudAgentTaskRuns)
          .where(eq(cloudAgentTaskRuns.taskId, taskId))
          .orderBy(desc(cloudAgentTaskRuns.sequence))
          .limit(1);
        const [created] = await transaction
          .insert(cloudAgentTaskRuns)
          .values({
            taskId,
            sequence: (latest?.sequence ?? 0) + 1,
            instruction,
            status: "submitting",
          })
          .returning({ id: cloudAgentTaskRuns.id });
        if (!created) throw new Error("The follow-up could not be recorded.");
        await transaction
          .update(cloudAgentTasks)
          .set({
            status: "submitting",
            lastError: null,
            finishedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(cloudAgentTasks.id, taskId));
        return created.id;
      });
    },

    async attachFollowup(taskId, runId, run) {
      const status = statusFromCursor(run.status);
      const now = new Date();
      const git = gitSummary(run);
      const lastError =
        status === "failed"
          ? (run.result ?? "Cursor reported an error.")
          : null;
      await database.transaction(async (transaction) => {
        await transaction
          .update(cloudAgentTaskRuns)
          .set({
            remoteRunId: run.id,
            status,
            result: run.result ?? null,
            durationMs: run.durationMs ?? null,
            git: git.git,
            lastError,
            updatedAt: now,
            ...(isTerminal(status) ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTaskRuns.id, runId));
        await transaction
          .update(cloudAgentTasks)
          .set({
            status,
            result: run.result ?? null,
            branch: git.branch,
            pullRequestUrl: git.pullRequestUrl,
            lastError,
            updatedAt: now,
            ...(isTerminal(status) ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTasks.id, taskId));
      });
    },

    async failFollowup(taskId, runId, error, status = "failed") {
      const now = new Date();
      await database.transaction(async (transaction) => {
        await transaction
          .update(cloudAgentTaskRuns)
          .set({
            status,
            lastError: error,
            updatedAt: now,
            ...(status === "failed" ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTaskRuns.id, runId));
        await transaction
          .update(cloudAgentTasks)
          .set({
            status,
            lastError: error,
            updatedAt: now,
            ...(status === "failed" ? { finishedAt: now } : {}),
          })
          .where(eq(cloudAgentTasks.id, taskId));
      });
    },
  };
}

export { isTerminal as isTerminalCloudAgentTask };
