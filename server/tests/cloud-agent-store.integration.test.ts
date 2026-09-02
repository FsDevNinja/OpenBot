import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createCloudAgentTaskStore } from "../src/cloud-agents/store";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createCloudAgentTaskStore(database);
const userIds: string[] = [];

afterEach(async () => {
  for (const userId of userIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

async function createOwner() {
  const id = `cloud-agent-store-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Cloud Agent Store Test",
  });
  userIds.push(id);
  return id;
}

test("an immediately completed initial run keeps its result and Git links", async () => {
  const ownerUserId = await createOwner();
  const taskId = randomUUID();
  const remoteAgentId = `bc-${taskId}`;
  await store.create({
    id: taskId,
    ownerUserId,
    requestingAgentId: "researcher",
    threadId: "thread-1",
    originatingRunId: "openbot-run-1",
    title: "Implement search",
    repositoryUrl: "https://github.com/acme/openbot",
    model: {
      id: "grok-4.6",
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    instruction: "Implement repository search and test it.",
    remoteAgentId,
  });

  await store.attachCreated({
    taskId,
    remoteUrl: `https://cursor.com/agents/${remoteAgentId}`,
    run: {
      id: "cursor-run-1",
      agentId: remoteAgentId,
      status: "FINISHED",
      durationMs: 1_234,
      result: "Implemented repository search.",
      git: {
        branches: [
          {
            repoUrl: "https://github.com/acme/openbot",
            branch: "cursor/repository-search",
            prUrl: "https://github.com/acme/openbot/pull/42",
          },
        ],
      },
    },
  });

  const task = await store.get(taskId, ownerUserId);
  expect(await store.get(taskId, "somebody-else")).toBeNull();
  expect(task).toMatchObject({
    status: "succeeded",
    model: {
      id: "grok-4.6",
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    result: "Implemented repository search.",
    branch: "cursor/repository-search",
    pullRequestUrl: "https://github.com/acme/openbot/pull/42",
  });
  expect(task?.finishedAt).toBeInstanceOf(Date);
  expect(task?.runs[0]).toMatchObject({
    status: "succeeded",
    result: "Implemented repository search.",
    durationMs: 1_234,
  });
  expect(task?.runs[0]?.finishedAt).toBeInstanceOf(Date);
});

test("an immediately completed follow-up replaces the task result", async () => {
  const ownerUserId = await createOwner();
  const taskId = randomUUID();
  const remoteAgentId = `bc-${taskId}`;
  await store.create({
    id: taskId,
    ownerUserId,
    requestingAgentId: "researcher",
    threadId: "thread-1",
    originatingRunId: "openbot-run-1",
    title: "Implement search",
    repositoryUrl: "https://github.com/acme/openbot",
    instruction: "Implement repository search.",
    remoteAgentId,
  });
  await store.attachCreated({
    taskId,
    remoteUrl: `https://cursor.com/agents/${remoteAgentId}`,
    run: {
      id: "cursor-run-1",
      agentId: remoteAgentId,
      status: "FINISHED",
      result: "Implemented search.",
    },
  });
  const localRunId = await store.beginFollowup(
    taskId,
    ownerUserId,
    "Add pagination.",
  );

  await store.attachFollowup(taskId, localRunId, {
    id: "cursor-run-2",
    agentId: remoteAgentId,
    status: "FINISHED",
    result: "Added pagination.",
    git: {
      branches: [
        {
          repoUrl: "https://github.com/acme/openbot",
          branch: "cursor/repository-search",
          prUrl: "https://github.com/acme/openbot/pull/42",
        },
      ],
    },
  });

  const task = await store.get(taskId, ownerUserId);
  expect(task).toMatchObject({
    status: "succeeded",
    result: "Added pagination.",
    branch: "cursor/repository-search",
    pullRequestUrl: "https://github.com/acme/openbot/pull/42",
  });
  expect(task?.runs).toHaveLength(2);
  expect(task?.runs[1]).toMatchObject({
    sequence: 2,
    status: "succeeded",
    result: "Added pagination.",
  });
  expect(task?.runs[1]?.finishedAt).toBeInstanceOf(Date);
});
