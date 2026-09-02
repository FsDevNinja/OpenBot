import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { runtimeRuns, runtimeThreads, users } from "../src/db/schema";
import { mountNativeRuntime } from "../src/runtime/native-runtime";
import { createNativeThreadStore } from "../src/runtime/thread-store";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";
import { LLMock } from "./support/protocol-mocks";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const actor = { id: `native-runtime-${randomUUID()}`, role: "admin" as const };
const model = new LLMock();
let previousBaseUrl: string | undefined;

beforeAll(async () => {
  await database.insert(users).values({
    id: actor.id,
    email: `${actor.id}@openbot.test`,
    name: "Native runtime test",
  });
  previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = await model.start();
});

afterAll(async () => {
  await database
    .delete(runtimeThreads)
    .where(eq(runtimeThreads.ownerUserId, actor.id));
  await database.delete(users).where(eq(users.id, actor.id));
  await model.stop();
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousBaseUrl;
});

function eventsFrom(body: string): { type: string; [key: string]: unknown }[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("native AG-UI runtime", () => {
  test("streams one answer and restores that same transcript from PostgreSQL", async () => {
    model.clearFixtures();
    model.onMessage(/native persistence/, {
      type: "text",
      content: "Stored exactly once.",
    });
    const store = createNativeThreadStore(database);
    const runtime = mountNativeRuntime(
      loadConfig(testEnvironment()),
      store,
      { provider: "openai", defaultModel: "gpt-5.5" },
      async () => [
        {
          id: "native-test",
          name: "Native test",
          type: "built_in",
          systemPrompt: "Answer briefly.",
        },
        {
          id: "other-test",
          name: "Other test",
          type: "built_in",
          systemPrompt: "Answer briefly.",
        },
      ],
      async () => "test-key",
      async () => actor,
      // Built-in agents never use the remote-agent fetch guard.
      {} as never,
    );
    const threadId = randomUUID();
    const runId = randomUUID();
    const response = await runtime.handler.request(
      `http://openbot.test/api/runtime/agents/native-test/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          runId,
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Check native persistence.",
            },
          ],
          state: {},
          tools: [],
          context: [],
        }),
      },
    );

    expect(response.status).toBe(200);
    const events = eventsFrom(await response.text());
    expect(
      events.filter((event) => event.type === "TEXT_MESSAGE_START"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT"),
    ).toEqual([expect.objectContaining({ delta: "Stored exactly once." })]);
    expect(
      events.filter((event) => event.type === "RUN_FINISHED"),
    ).toHaveLength(1);

    const history = await store.history({ threadId, actorId: actor.id });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      role: "user",
      content: "Check native persistence.",
    });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: "Stored exactly once.",
    });
    const [run] = await database
      .select({ status: runtimeRuns.status })
      .from(runtimeRuns)
      .where(eq(runtimeRuns.id, runId));
    expect(run?.status).toBe("succeeded");

    const restored = await runtime.handler.request(
      `http://openbot.test/api/runtime/threads/${threadId}/messages`,
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).messages).toEqual(history);

    const crossed = await runtime.handler.request(
      "http://openbot.test/api/runtime/agents/other-test/run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          runId: randomUUID(),
          messages: history,
          state: {},
          tools: [],
          context: [],
        }),
      },
    );
    expect(crossed.status).toBe(403);
    expect(await crossed.json()).toEqual({
      error: "That conversation belongs to another Bot.",
    });
  });
});
