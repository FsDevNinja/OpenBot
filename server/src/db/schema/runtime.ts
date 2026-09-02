import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { jsonb } from "./json";
import { users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A conversation owned by OpenBot itself.
 *
 * Channels point at these ids, but the runtime does not point back at channels. That separation is
 * intentional: a direct chat, a routine scratchpad, and a future multi-agent channel are all thread
 * consumers rather than special modes inside the model runner.
 */
export const runtimeThreads = pgTable(
  "runtime_threads",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The currently bound Bot. Nullable only so deleting a Bot never deletes its transcript. */
    agentId: text("agent_id"),
    messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
    state: jsonb("state").notNull().default({}),
    activeRunId: text("active_run_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("runtime_threads_owner_updated_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
  ],
);

/** A durable run ledger; transcript state remains on the thread for one-read restoration. */
export const runtimeRuns = pgTable(
  "runtime_runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => runtimeThreads.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("runtime_runs_thread_started_idx").on(
      table.threadId,
      table.startedAt,
    ),
  ],
);
