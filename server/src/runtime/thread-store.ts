import type { Message } from "@ag-ui/client";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { runtimeRuns, runtimeThreads } from "../db/schema";

const LEASE_MS = 120_000;

export class ThreadAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadAccessError";
  }
}

export type NativeThreadStore = ReturnType<typeof createNativeThreadStore>;

/** PostgreSQL is both the durable transcript store and the cross-replica run lock. */
export function createNativeThreadStore(database: Database) {
  return {
    async ensure(input: {
      threadId: string;
      actorId: string;
      agentId: string;
    }): Promise<void> {
      await database
        .insert(runtimeThreads)
        .values({
          id: input.threadId,
          ownerUserId: input.actorId,
          agentId: input.agentId,
        })
        .onConflictDoNothing();
      const [thread] = await database
        .select({
          ownerUserId: runtimeThreads.ownerUserId,
          agentId: runtimeThreads.agentId,
        })
        .from(runtimeThreads)
        .where(eq(runtimeThreads.id, input.threadId))
        .limit(1);
      if (!thread || thread.ownerUserId !== input.actorId) {
        throw new ThreadAccessError(
          "That conversation belongs to another person.",
        );
      }
      if (thread.agentId && thread.agentId !== input.agentId) {
        throw new ThreadAccessError(
          "That conversation belongs to another Bot.",
        );
      }
    },

    async history(input: {
      threadId: string;
      actorId: string;
    }): Promise<Message[]> {
      const [thread] = await database
        .select({ messages: runtimeThreads.messages })
        .from(runtimeThreads)
        .where(
          and(
            eq(runtimeThreads.id, input.threadId),
            eq(runtimeThreads.ownerUserId, input.actorId),
          ),
        )
        .limit(1);
      return (thread?.messages ?? []) as unknown as Message[];
    },

    /** Internal read authorized by the run lease rather than by a browser session. */
    async historyForRun(input: {
      threadId: string;
      runId: string;
    }): Promise<Message[]> {
      const [thread] = await database
        .select({ messages: runtimeThreads.messages })
        .from(runtimeThreads)
        .where(
          and(
            eq(runtimeThreads.id, input.threadId),
            eq(runtimeThreads.activeRunId, input.runId),
          ),
        )
        .limit(1);
      if (!thread)
        throw new Error("The conversation run lease is no longer held.");
      return thread.messages as unknown as Message[];
    },

    async read(input: { threadId: string; actorId: string }) {
      const [thread] = await database
        .select({
          agentId: runtimeThreads.agentId,
          messages: runtimeThreads.messages,
          state: runtimeThreads.state,
        })
        .from(runtimeThreads)
        .where(
          and(
            eq(runtimeThreads.id, input.threadId),
            eq(runtimeThreads.ownerUserId, input.actorId),
          ),
        )
        .limit(1);
      return thread
        ? {
            ...thread,
            messages: thread.messages as unknown as Message[],
            state: thread.state as Record<string, unknown>,
          }
        : null;
    },

    async exists(input: {
      threadId: string;
      actorId: string;
    }): Promise<boolean> {
      const [thread] = await database
        .select({ id: runtimeThreads.id })
        .from(runtimeThreads)
        .where(
          and(
            eq(runtimeThreads.id, input.threadId),
            eq(runtimeThreads.ownerUserId, input.actorId),
          ),
        )
        .limit(1);
      return thread !== undefined;
    },

    async acquire(input: {
      threadId: string;
      runId: string;
      userId: string;
      agentId: string;
    }): Promise<{ runId: string } | null> {
      return database.transaction(async (transaction) => {
        await transaction
          .insert(runtimeThreads)
          .values({
            id: input.threadId,
            ownerUserId: input.userId,
            agentId: input.agentId,
          })
          .onConflictDoNothing();

        const [known] = await transaction
          .select({
            ownerUserId: runtimeThreads.ownerUserId,
            agentId: runtimeThreads.agentId,
          })
          .from(runtimeThreads)
          .where(eq(runtimeThreads.id, input.threadId))
          .limit(1);
        if (!known || known.ownerUserId !== input.userId) {
          throw new ThreadAccessError(
            "That conversation belongs to another person.",
          );
        }
        if (known.agentId && known.agentId !== input.agentId) {
          throw new ThreadAccessError(
            "That conversation belongs to another Bot.",
          );
        }

        const now = new Date();
        const [held] = await transaction
          .update(runtimeThreads)
          .set({
            agentId: input.agentId,
            activeRunId: input.runId,
            leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
            updatedAt: now,
          })
          .where(
            and(
              eq(runtimeThreads.id, input.threadId),
              or(
                isNull(runtimeThreads.activeRunId),
                lt(runtimeThreads.leaseExpiresAt, now),
                eq(runtimeThreads.activeRunId, input.runId),
              ),
            ),
          )
          .returning({ id: runtimeThreads.id });
        if (!held) return null;

        await transaction
          .insert(runtimeRuns)
          .values({
            id: input.runId,
            threadId: input.threadId,
            agentId: input.agentId,
            status: "running",
          })
          .onConflictDoNothing();

        const [knownRun] = await transaction
          .select({
            threadId: runtimeRuns.threadId,
            agentId: runtimeRuns.agentId,
          })
          .from(runtimeRuns)
          .where(eq(runtimeRuns.id, input.runId))
          .limit(1);
        if (
          !knownRun ||
          knownRun.threadId !== input.threadId ||
          knownRun.agentId !== input.agentId
        ) {
          throw new ThreadAccessError(
            "That run belongs to another conversation or Bot.",
          );
        }
        await transaction
          .update(runtimeRuns)
          .set({
            status: "running",
            error: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(runtimeRuns.id, input.runId));
        return { runId: input.runId };
      });
    },

    async renew(input: { threadId: string; runId: string }): Promise<void> {
      const [held] = await database
        .update(runtimeThreads)
        .set({
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runtimeThreads.id, input.threadId),
            eq(runtimeThreads.activeRunId, input.runId),
          ),
        )
        .returning({ id: runtimeThreads.id });
      if (!held)
        throw new Error("The conversation run lease is no longer held.");
    },

    async finish(input: {
      threadId: string;
      runId: string;
      messages: Message[];
      state: unknown;
      error?: string;
    }): Promise<void> {
      const now = new Date();
      await database.transaction(async (transaction) => {
        await transaction
          .update(runtimeThreads)
          .set({
            messages: input.messages as unknown as Record<string, unknown>,
            state: (input.state ?? {}) as Record<string, unknown>,
            activeRunId: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(runtimeThreads.id, input.threadId),
              eq(runtimeThreads.activeRunId, input.runId),
            ),
          );
        await transaction
          .update(runtimeRuns)
          .set({
            status: input.error ? "failed" : "succeeded",
            error: input.error ?? null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(runtimeRuns.id, input.runId));
      });
    },

    async release(input: { threadId: string; runId: string }): Promise<void> {
      const now = new Date();
      await database.transaction(async (transaction) => {
        await transaction
          .update(runtimeThreads)
          .set({ activeRunId: null, leaseExpiresAt: null, updatedAt: now })
          .where(
            and(
              eq(runtimeThreads.id, input.threadId),
              eq(runtimeThreads.activeRunId, input.runId),
            ),
          );
        await transaction
          .update(runtimeRuns)
          .set({ status: "cancelled", completedAt: now, updatedAt: now })
          .where(
            and(
              eq(runtimeRuns.id, input.runId),
              eq(runtimeRuns.status, "running"),
            ),
          );
      });
    },
  };
}
