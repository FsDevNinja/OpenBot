import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A durable piece of development work handed from an OpenBot coworker to an external executor.
 *
 * The external agent is not an OpenBot agent: it is a worker the coworker can start and steer. The
 * row therefore belongs to the person whose provider connection paid for it, while
 * `requestingAgentId` is attribution rather than ownership.
 */
export const cloudAgentTasks = pgTable(
  "cloud_agent_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestingAgentId: text("requesting_agent_id").notNull(),
    threadId: text("thread_id").notNull(),
    originatingRunId: text("originating_run_id").notNull(),
    provider: text("provider").notNull(),
    title: text("title").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    startingRef: text("starting_ref"),
    model: jsonb("model"),
    initialInstruction: text("initial_instruction").notNull(),
    status: text("status").notNull(),
    remoteAgentId: text("remote_agent_id").notNull(),
    remoteUrl: text("remote_url"),
    result: text("result"),
    branch: text("branch"),
    pullRequestUrl: text("pull_request_url"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("cloud_agent_tasks_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    index("cloud_agent_tasks_active_idx").on(table.status, table.updatedAt),
    uniqueIndex("cloud_agent_tasks_remote_agent_idx").on(
      table.provider,
      table.remoteAgentId,
    ),
  ],
);

/** Every prompt sent to the durable remote agent, including its initial prompt. */
export const cloudAgentTaskRuns = pgTable(
  "cloud_agent_task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => cloudAgentTasks.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    instruction: text("instruction").notNull(),
    remoteRunId: text("remote_run_id"),
    status: text("status").notNull(),
    result: text("result"),
    durationMs: integer("duration_ms"),
    git: jsonb("git").notNull().default({}),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("cloud_agent_task_runs_sequence_idx").on(
      table.taskId,
      table.sequence,
    ),
    uniqueIndex("cloud_agent_task_runs_remote_idx").on(table.remoteRunId),
    index("cloud_agent_task_runs_task_created_idx").on(
      table.taskId,
      table.createdAt,
    ),
  ],
);
