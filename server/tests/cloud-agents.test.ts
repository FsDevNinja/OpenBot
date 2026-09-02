import { describe, expect, test } from "bun:test";
import type { CloudAgentConnectionStore } from "../src/cloud-agents/connections";
import { createCloudAgentConnectionStore } from "../src/cloud-agents/connections";
import {
  type CursorClient,
  type CursorRun,
  createCursorClient,
} from "../src/cloud-agents/cursor-client";
import { createCloudAgentTaskService } from "../src/cloud-agents/service";
import type {
  CloudAgentRunRecord,
  CloudAgentTask,
  CloudAgentTaskStatus,
  CloudAgentTaskStore,
} from "../src/cloud-agents/store";
import {
  CLOUD_DEVELOPMENT_TOOL_NAMES,
  cloudDevelopmentTools,
} from "../src/cloud-agents/tools";
import type {
  CredentialSecretReader,
  CredentialStore,
  CredentialStoreValue,
} from "../src/credentials";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function memoryVault() {
  const values = new Map<
    string,
    CredentialStoreValue & { id: string; revokedAt: Date | null }
  >();
  let sequence = 0;
  const store: CredentialStore & CredentialSecretReader = {
    async create(value) {
      const id = `credential-${++sequence}`;
      values.set(id, { ...value, id, revokedAt: null });
      return { id, revokedAt: null };
    },
    async updateSecret(id, encryptedValue) {
      const row = values.get(id);
      if (!row) throw new Error("missing");
      row.encryptedValue = encryptedValue;
    },
    async rotate(input) {
      const previous = values.get(input.previousCredentialId);
      if (!previous) throw new Error("missing");
      previous.revokedAt = new Date();
      const id = `credential-${++sequence}`;
      values.set(id, { ...input, id, revokedAt: null });
      return { id, revokedAt: null };
    },
    async revoke(id) {
      const row = values.get(id);
      if (!row) throw new Error("missing");
      row.revokedAt = new Date();
      return row.revokedAt;
    },
    async isLive(id) {
      return values.get(id)?.revokedAt === null;
    },
    async findLiveByKey(key) {
      const row = [...values.values()].find(
        (candidate) =>
          candidate.kind === key.kind &&
          candidate.provider === key.provider &&
          candidate.keyId === key.keyId &&
          candidate.revokedAt === null,
      );
      return row ? { id: row.id } : null;
    },
    async readSecret(id) {
      const row = values.get(id);
      return row
        ? { encryptedValue: row.encryptedValue, revokedAt: row.revokedAt }
        : null;
    },
  };
  return {
    store,
    reader: store,
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    auditStore: { insert: async () => undefined },
  };
}

describe("the Cursor Cloud Agents client", () => {
  test("verifies a key with Basic authentication and creates work on a separate branch", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      json({ apiKeyName: "OpenBot", userEmail: "dev@example.com" }),
      json({
        items: [
          {
            id: "grok-4.6",
            displayName: "Cursor Grok 4.6",
            aliases: ["grok-latest"],
            parameters: [
              {
                id: "effort",
                displayName: "Effort",
                values: [{ value: "high", displayName: "High" }],
              },
            ],
            variants: [
              {
                params: [{ id: "effort", value: "high" }],
                displayName: "Cursor Grok 4.6",
                isDefault: true,
              },
            ],
          },
        ],
      }),
      json({
        agent: {
          id: "bc-11111111-1111-4111-8111-111111111111",
          name: "Fix it",
          status: "ACTIVE",
          url: "https://cursor.com/agents/bc-111",
          latestRunId: "run-1",
        },
        run: {
          id: "run-1",
          agentId: "bc-11111111-1111-4111-8111-111111111111",
          status: "CREATING",
        },
      }),
    ];
    const client = createCursorClient({
      baseUrl: "https://cursor.example.test",
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      }) as typeof fetch,
    });

    await expect(client.keyInfo("secret-key")).resolves.toMatchObject({
      apiKeyName: "OpenBot",
    });
    await expect(client.listModels("secret-key")).resolves.toMatchObject([
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [{ id: "effort", values: [{ value: "high" }] }],
      },
    ]);
    await client.createAgent("secret-key", {
      agentId: "bc-11111111-1111-4111-8111-111111111111",
      name: "Fix it",
      prompt: "Implement and test the fix",
      repositoryUrl: "https://github.com/acme/project",
      startingRef: "release",
      autoCreatePR: true,
      model: {
        id: "grok-4.6",
        params: [{ id: "effort", value: "high" }],
      },
    });

    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("secret-key:").toString("base64")}`,
    });
    expect(requests[1]?.url).toBe("https://cursor.example.test/v1/models");
    expect(JSON.parse(String(requests[2]?.init?.body))).toMatchObject({
      agentId: "bc-11111111-1111-4111-8111-111111111111",
      repos: [
        {
          url: "https://github.com/acme/project",
          startingRef: "release",
        },
      ],
      model: {
        id: "grok-4.6",
        params: [{ id: "effort", value: "high" }],
      },
      workOnCurrentBranch: false,
      autoCreatePR: true,
    });
  });

  test("rejects malformed nested Git output from Cursor", async () => {
    const client = createCursorClient({
      fetch: (async () =>
        json({
          id: "run-1",
          agentId: "agent-1",
          status: "FINISHED",
          git: { branches: [{ repoUrl: 42 }] },
        })) as typeof fetch,
    });

    await expect(
      client.getRun("secret-key", "agent-1", "run-1"),
    ).rejects.toThrow("invalid Git repository URL");
  });
});

describe("personal cloud-agent connections", () => {
  test("verifies and isolates each user's Cursor key", async () => {
    const cursor = {
      async keyInfo(key: string) {
        if (key === "bad") throw new Error("unauthorized");
        return { apiKeyName: "OpenBot" };
      },
    } as CursorClient;
    const connections = createCloudAgentConnectionStore(memoryVault(), cursor);
    const alice = { id: "alice", role: "user" } as const;
    const bob = { id: "bob", role: "user" } as const;

    await connections.connect(alice, "cursor", "alice-key");
    expect(await connections.hasConnection("alice")).toBe(true);
    expect(await connections.hasConnection("bob")).toBe(false);
    expect(await connections.apiKeyFor("alice")).toBe("alice-key");
    expect(await connections.apiKeyFor("bob")).toBeNull();
    expect(await connections.statuses(alice)).toMatchObject([
      { id: "cursor", connected: true },
    ]);
    expect(await connections.statuses(bob)).toMatchObject([
      { id: "cursor", connected: false },
    ]);
    expect(JSON.stringify(await connections.statuses(alice))).not.toContain(
      "alice-key",
    );

    await connections.connect(bob, "cursor", "bob-key");
    await connections.disconnect(alice, "cursor");
    expect(await connections.apiKeyFor("alice")).toBeNull();
    expect(await connections.apiKeyFor("bob")).toBe("bob-key");

    await expect(connections.connect(bob, "cursor", "bad")).rejects.toThrow(
      "Cursor did not accept",
    );
    expect(await connections.apiKeyFor("bob")).toBe("bob-key");
  });
});

function statusFrom(run: CursorRun): CloudAgentTaskStatus {
  return run.status === "FINISHED"
    ? "succeeded"
    : run.status === "CANCELLED"
      ? "cancelled"
      : run.status === "CREATING"
        ? "queued"
        : "running";
}

function memoryTaskStore() {
  let task: CloudAgentTask | null = null;
  const store: CloudAgentTaskStore = {
    async create(input) {
      const now = new Date();
      task = {
        id: input.id,
        ownerUserId: input.ownerUserId,
        requestingAgentId: input.requestingAgentId,
        threadId: input.threadId,
        originatingRunId: input.originatingRunId,
        provider: "cursor",
        title: input.title,
        repositoryUrl: input.repositoryUrl,
        startingRef: input.startingRef ?? null,
        model: input.model ?? null,
        initialInstruction: input.instruction,
        status: "submitting",
        remoteAgentId: input.remoteAgentId,
        remoteUrl: null,
        result: null,
        branch: null,
        pullRequestUrl: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        runs: [
          {
            id: "local-run-1",
            sequence: 1,
            instruction: input.instruction,
            remoteRunId: null,
            status: "submitting",
            result: null,
            durationMs: null,
            git: {},
            lastError: null,
            createdAt: now,
            updatedAt: now,
            finishedAt: null,
          },
        ],
      };
    },
    async attachCreated({ remoteUrl, run }) {
      if (!task) throw new Error("missing task");
      task.remoteUrl = remoteUrl;
      task.status = statusFrom(run);
      task.runs[0]!.remoteRunId = run.id;
      task.runs[0]!.status = task.status;
    },
    async markSubmission({ status, error }) {
      if (!task) throw new Error("missing task");
      task.status = status;
      task.lastError = error;
    },
    async get(taskId, ownerUserId) {
      return task &&
        task.id === taskId &&
        (!ownerUserId || ownerUserId === task.ownerUserId)
        ? task
        : null;
    },
    async active() {
      return task ? [{ id: task.id, ownerUserId: task.ownerUserId }] : [];
    },
    async updateFromRemote(_taskId, run) {
      if (!task) throw new Error("missing task");
      const current = task.runs.at(-1) as CloudAgentRunRecord;
      task.status = statusFrom(run);
      task.result = run.result ?? null;
      current.status = task.status;
      current.result = run.result ?? null;
      const branch = run.git?.branches?.at(-1);
      task.branch = branch?.branch ?? null;
      task.pullRequestUrl = branch?.prUrl ?? null;
    },
    async beginFollowup(_taskId, ownerUserId, instruction) {
      if (!task || task.ownerUserId !== ownerUserId)
        throw new Error("missing task");
      const now = new Date();
      const id = `local-run-${task.runs.length + 1}`;
      task.runs.push({
        id,
        sequence: task.runs.length + 1,
        instruction,
        remoteRunId: null,
        status: "submitting",
        result: null,
        durationMs: null,
        git: {},
        lastError: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      });
      task.status = "submitting";
      return id;
    },
    async attachFollowup(_taskId, runId, run) {
      if (!task) throw new Error("missing task");
      const local = task.runs.find((candidate) => candidate.id === runId);
      if (!local) throw new Error("missing run");
      local.remoteRunId = run.id;
      local.status = statusFrom(run);
      task.status = local.status;
    },
    async failFollowup(_taskId, runId, error, status = "failed") {
      if (!task) throw new Error("missing task");
      const local = task.runs.find((candidate) => candidate.id === runId);
      if (!local) throw new Error("missing run");
      local.status = status;
      local.lastError = error;
      task.status = status;
      task.lastError = error;
    },
  };
  return store;
}

describe("durable cloud development tasks", () => {
  test("starts, refreshes, follows up, and cancels one durable Cursor agent", async () => {
    const calls: string[] = [];
    let current: CursorRun = {
      id: "run-1",
      agentId: "placeholder",
      status: "CREATING",
    };
    const cursor: CursorClient = {
      async keyInfo() {
        return { apiKeyName: "test" };
      },
      async listModels(key) {
        calls.push(`models:${key}`);
        return [
          {
            id: "grok-4.6",
            displayName: "Cursor Grok 4.6",
            aliases: [],
            parameters: [
              {
                id: "effort",
                values: [{ value: "high" }, { value: "xhigh" }],
              },
              {
                id: "fast",
                values: [{ value: "false" }, { value: "true" }],
              },
            ],
            variants: [
              {
                params: [
                  { id: "effort", value: "high" },
                  { id: "fast", value: "false" },
                ],
                displayName: "Cursor Grok 4.6",
              },
              {
                params: [
                  { id: "effort", value: "high" },
                  { id: "fast", value: "true" },
                ],
                displayName: "Cursor Grok 4.6",
                isDefault: true,
              },
            ],
          },
        ];
      },
      async createAgent(_key, input) {
        calls.push(
          `create:${input.agentId}:${input.model?.id ?? "default"}:${input.model?.params?.map((parameter) => `${parameter.id}=${parameter.value}`).join(",") ?? ""}`,
        );
        current = { ...current, agentId: input.agentId };
        return {
          agent: {
            id: input.agentId,
            name: input.name,
            status: "ACTIVE",
            url: `https://cursor.com/agents/${input.agentId}`,
            latestRunId: current.id,
          },
          run: current,
        };
      },
      async getAgent(_key, agentId) {
        return {
          id: agentId,
          name: "Fix it",
          status: "ACTIVE",
          url: `https://cursor.com/agents/${agentId}`,
          latestRunId: current.id,
        };
      },
      async createRun(_key, agentId) {
        calls.push(`update:${agentId}`);
        current = { id: "run-2", agentId, status: "RUNNING" };
        return current;
      },
      async getRun() {
        return current;
      },
      async cancelRun(_key, agentId, runId) {
        calls.push(`cancel:${agentId}:${runId}`);
        current = { ...current, status: "CANCELLED" };
      },
    };
    const connections = {
      async hasConnection(actorId) {
        return actorId === "alice";
      },
      async apiKeyFor(actorId) {
        return actorId === "alice" ? "alice-cursor-key" : null;
      },
    } as CloudAgentConnectionStore;
    const service = createCloudAgentTaskService({
      store: memoryTaskStore(),
      connections,
      cursor,
    });

    let task = await service.start({
      actorId: "alice",
      botId: "chief-of-staff",
      threadId: "thread-1",
      runId: "run-openbot-1",
      title: "Fix it",
      repositoryUrl: "https://github.com/acme/project",
      startingRef: "release",
      instruction: "Implement and test the fix.",
      model: {
        id: "grok-4.6",
        params: [{ id: "effort", value: "high" }],
      },
    });
    expect(task.status).toBe("queued");
    expect(task.remoteAgentId).toStartWith("bc-");
    expect(task.model).toEqual({
      id: "grok-4.6",
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    });
    expect(calls).toEqual([
      "models:alice-cursor-key",
      `create:${task.remoteAgentId}:grok-4.6:effort=high,fast=false`,
    ]);

    current = {
      ...current,
      status: "FINISHED",
      result: "Implemented the fix.",
      git: {
        branches: [
          {
            repoUrl: "github.com/acme/project",
            branch: "cursor/fix-it",
            prUrl: "https://github.com/acme/project/pull/42",
          },
        ],
      },
    };
    task = await service.get("alice", task.id);
    expect(task).toMatchObject({
      status: "succeeded",
      branch: "cursor/fix-it",
      pullRequestUrl: "https://github.com/acme/project/pull/42",
    });

    task = await service.update(
      "alice",
      task.id,
      "Also add a regression test.",
    );
    expect(task.status).toBe("running");
    task = await service.cancel("alice", task.id);
    expect(task.status).toBe("cancelled");
    expect(calls).toContain(`cancel:${task.remoteAgentId}:run-2`);
  });

  test("rejects a model option that the user's Cursor connection does not offer", async () => {
    let created = false;
    const cursor = {
      async listModels() {
        return [
          {
            id: "grok-4.6",
            displayName: "Cursor Grok 4.6",
            aliases: [],
            parameters: [
              {
                id: "fast",
                values: [{ value: "false" }, { value: "true" }],
              },
            ],
            variants: [],
          },
        ];
      },
      async createAgent() {
        created = true;
        throw new Error("should not be called");
      },
    } as CursorClient;
    const connections = {
      async apiKeyFor() {
        return "alice-cursor-key";
      },
    } as CloudAgentConnectionStore;
    const service = createCloudAgentTaskService({
      store: memoryTaskStore(),
      connections,
      cursor,
    });

    await expect(
      service.start({
        actorId: "alice",
        botId: "researcher",
        threadId: "thread-1",
        runId: "run-1",
        title: "Build it",
        repositoryUrl: "https://github.com/acme/project",
        instruction: "Implement it.",
        model: {
          id: "grok-4.6",
          params: [{ id: "fast", value: "turbo" }],
        },
      }),
    ).rejects.toThrow("does not support fast=turbo");
    expect(created).toBe(false);
  });

  test("exposes model discovery and the five governed task tools with run attribution", async () => {
    const started: unknown[] = [];
    const service = {
      async listModels() {
        return [
          {
            id: "grok-4.6",
            displayName: "Cursor Grok 4.6",
            aliases: [],
            parameters: [],
            variants: [],
          },
        ];
      },
      async start(input: unknown) {
        started.push(input);
        return {
          id: "11111111-1111-4111-8111-111111111111",
          provider: "cursor",
          title: "Build it",
          repositoryUrl: "https://github.com/acme/project",
          model: {
            id: "grok-4.6",
            displayName: "Cursor Grok 4.6",
            params: [],
          },
          status: "queued",
          remoteUrl: "https://cursor.com/agents/bc-1",
          branch: null,
          pullRequestUrl: null,
          result: null,
          lastError: null,
        };
      },
    } as never;
    const tools = cloudDevelopmentTools({
      service,
      run: {
        actorId: "alice",
        botId: "researcher",
        runId: "run-1",
        threadId: "thread-1",
      },
    });
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      CLOUD_DEVELOPMENT_TOOL_NAMES,
    );
    const result = await tools[0]!.execute({
      title: "Build it",
      repositoryUrl: "https://github.com/acme/project",
      instruction: "Implement it.",
      model: { id: "grok-4.6" },
    });
    expect(JSON.parse(result)).toMatchObject({
      taskId: "11111111-1111-4111-8111-111111111111",
      status: "queued",
      model: { id: "grok-4.6" },
    });
    expect(started[0]).toMatchObject({
      actorId: "alice",
      botId: "researcher",
      runId: "run-1",
      threadId: "thread-1",
      model: { id: "grok-4.6" },
    });
    const listed = await tools[1]!.execute({});
    expect(JSON.parse(listed)).toMatchObject({
      provider: "cursor",
      models: [{ id: "grok-4.6" }],
    });
  });
});
