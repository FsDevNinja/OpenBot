import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runtimeRuns, runtimeThreads, users } from "../src/db/schema";
import {
  createNativeThreadStore,
  ThreadAccessError,
} from "../src/runtime/thread-store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createNativeThreadStore(database);
const suite = randomUUID();
const ownerId = `native-owner-${suite}`;
const otherId = `native-other-${suite}`;

beforeAll(async () => {
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@openbot.test`, name: "Owner" },
    { id: otherId, email: `${otherId}@openbot.test`, name: "Other" },
  ]);
});

afterAll(async () => {
  await database
    .delete(runtimeThreads)
    .where(eq(runtimeThreads.ownerUserId, ownerId));
  await database
    .delete(runtimeThreads)
    .where(eq(runtimeThreads.ownerUserId, otherId));
  await database.delete(users).where(eq(users.id, ownerId));
  await database.delete(users).where(eq(users.id, otherId));
});

describe("native thread persistence", () => {
  test("persists a completed transcript and run result", async () => {
    const threadId = `thread-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    expect(
      await store.acquire({
        threadId,
        runId,
        userId: ownerId,
        agentId: "researcher",
      }),
    ).toEqual({ runId });

    const messages = [
      { id: "u1", role: "user" as const, content: "Research this." },
      { id: "a1", role: "assistant" as const, content: "Done." },
    ];
    await store.finish({ threadId, runId, messages, state: { page: 2 } });

    expect(await store.history({ threadId, actorId: ownerId })).toEqual(
      messages,
    );
    expect(await store.read({ threadId, actorId: ownerId })).toMatchObject({
      agentId: "researcher",
      messages,
      state: { page: 2 },
    });
    const [run] = await database
      .select({ status: runtimeRuns.status, error: runtimeRuns.error })
      .from(runtimeRuns)
      .where(eq(runtimeRuns.id, runId));
    expect(run).toEqual({ status: "succeeded", error: null });
  });

  test("uses the database lease to reject a concurrent run", async () => {
    const threadId = `thread-${randomUUID()}`;
    const first = `run-${randomUUID()}`;
    const second = `run-${randomUUID()}`;
    expect(
      await store.acquire({
        threadId,
        runId: first,
        userId: ownerId,
        agentId: "chief",
      }),
    ).not.toBeNull();
    expect(
      await store.acquire({
        threadId,
        runId: second,
        userId: ownerId,
        agentId: "chief",
      }),
    ).toBeNull();

    await store.release({ threadId, runId: first });
    expect(
      await store.acquire({
        threadId,
        runId: second,
        userId: ownerId,
        agentId: "chief",
      }),
    ).not.toBeNull();
    await store.release({ threadId, runId: second });
  });

  test("keeps owners and agents from crossing thread boundaries", async () => {
    const threadId = `thread-${randomUUID()}`;
    await store.ensure({ threadId, actorId: ownerId, agentId: "chief" });

    expect(await store.history({ threadId, actorId: otherId })).toEqual([]);
    await expect(
      store.ensure({ threadId, actorId: otherId, agentId: "chief" }),
    ).rejects.toBeInstanceOf(ThreadAccessError);
    await expect(
      store.ensure({ threadId, actorId: ownerId, agentId: "researcher" }),
    ).rejects.toBeInstanceOf(ThreadAccessError);
  });

  test("does not let a run id cross conversation boundaries", async () => {
    const firstThreadId = `thread-${randomUUID()}`;
    const secondThreadId = `thread-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    await store.acquire({
      threadId: firstThreadId,
      runId,
      userId: ownerId,
      agentId: "chief",
    });
    await store.release({ threadId: firstThreadId, runId });

    await expect(
      store.acquire({
        threadId: secondThreadId,
        runId,
        userId: ownerId,
        agentId: "chief",
      }),
    ).rejects.toBeInstanceOf(ThreadAccessError);

    const [run] = await database
      .select({ threadId: runtimeRuns.threadId, status: runtimeRuns.status })
      .from(runtimeRuns)
      .where(eq(runtimeRuns.id, runId));
    expect(run).toEqual({ threadId: firstThreadId, status: "cancelled" });
  });
});
