const CURSOR_API_BASE = "https://api.cursor.com";
const REQUEST_TIMEOUT_MS = 30_000;

export type CursorKeyInfo = {
  apiKeyName: string;
  createdAt?: string;
  userEmail?: string;
};

export type CursorModelParameterValue = {
  id: string;
  value: string;
};

export type CursorModelSelection = {
  id: string;
  params?: CursorModelParameterValue[];
};

export type CursorModel = {
  id: string;
  displayName: string;
  description?: string;
  aliases: string[];
  parameters: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants: Array<{
    params: CursorModelParameterValue[];
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }>;
};

export type CursorGitBranch = {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
};

export type CursorRun = {
  id: string;
  agentId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
  result?: string;
  git?: { branches?: CursorGitBranch[] };
};

export type CursorAgent = {
  id: string;
  name: string;
  status: string;
  url: string;
  latestRunId: string;
};

export class CursorApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CursorApiError";
    this.status = status;
    this.code = code;
  }
}

export type CursorClient = {
  keyInfo(apiKey: string): Promise<CursorKeyInfo>;
  listModels(apiKey: string): Promise<CursorModel[]>;
  createAgent(
    apiKey: string,
    input: {
      agentId: string;
      name: string;
      prompt: string;
      repositoryUrl: string;
      startingRef?: string;
      autoCreatePR: boolean;
      model?: CursorModelSelection;
    },
  ): Promise<{ agent: CursorAgent; run: CursorRun }>;
  getAgent(apiKey: string, agentId: string): Promise<CursorAgent>;
  createRun(
    apiKey: string,
    agentId: string,
    prompt: string,
  ): Promise<CursorRun>;
  getRun(apiKey: string, agentId: string, runId: string): Promise<CursorRun>;
  cancelRun(apiKey: string, agentId: string, runId: string): Promise<void>;
};

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Cursor returned an invalid ${name}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function gitFrom(value: unknown): CursorRun["git"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor returned invalid Git output.");
  }
  const branches = (value as Record<string, unknown>).branches;
  if (branches === undefined) return {};
  if (!Array.isArray(branches)) {
    throw new Error("Cursor returned invalid Git branches.");
  }
  return {
    branches: branches.map((branch) => {
      if (!branch || typeof branch !== "object" || Array.isArray(branch)) {
        throw new Error("Cursor returned an invalid Git branch.");
      }
      const row = branch as Record<string, unknown>;
      return {
        repoUrl: stringField(row.repoUrl, "Git repository URL"),
        ...(optionalString(row.branch)
          ? { branch: optionalString(row.branch) }
          : {}),
        ...(optionalString(row.prUrl)
          ? { prUrl: optionalString(row.prUrl) }
          : {}),
      };
    }),
  };
}

function runFrom(value: unknown): CursorRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor returned an invalid run.");
  }
  const row = value as Record<string, unknown>;
  return {
    id: stringField(row.id, "run id"),
    agentId: stringField(row.agentId, "agent id"),
    status: stringField(row.status, "run status"),
    ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === "string" ? { updatedAt: row.updatedAt } : {}),
    ...(typeof row.durationMs === "number"
      ? { durationMs: row.durationMs }
      : {}),
    ...(typeof row.result === "string" ? { result: row.result } : {}),
    ...(row.git ? { git: gitFrom(row.git) } : {}),
  };
}

function agentFrom(value: unknown): CursorAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor returned an invalid agent.");
  }
  const row = value as Record<string, unknown>;
  return {
    id: stringField(row.id, "agent id"),
    name: stringField(row.name, "agent name"),
    status: stringField(row.status, "agent status"),
    url: stringField(row.url, "agent URL"),
    latestRunId: stringField(row.latestRunId, "latest run id"),
  };
}

function parameterValueFrom(value: unknown): CursorModelParameterValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor returned an invalid model parameter value.");
  }
  const row = value as Record<string, unknown>;
  return {
    id: stringField(row.id, "model parameter id"),
    value: stringField(row.value, "model parameter value"),
  };
}

function modelFrom(value: unknown): CursorModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor returned an invalid model.");
  }
  const row = value as Record<string, unknown>;
  const parameters = row.parameters ?? [];
  const variants = row.variants ?? [];
  if (!Array.isArray(parameters) || !Array.isArray(variants)) {
    throw new Error("Cursor returned invalid model options.");
  }
  return {
    id: stringField(row.id, "model id"),
    displayName: stringField(row.displayName, "model display name"),
    ...(optionalString(row.description)
      ? { description: optionalString(row.description) }
      : {}),
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter(
          (alias): alias is string => typeof alias === "string",
        )
      : [],
    parameters: parameters.map((parameter) => {
      if (
        !parameter ||
        typeof parameter !== "object" ||
        Array.isArray(parameter)
      ) {
        throw new Error("Cursor returned an invalid model parameter.");
      }
      const option = parameter as Record<string, unknown>;
      if (!Array.isArray(option.values)) {
        throw new Error("Cursor returned invalid model parameter values.");
      }
      return {
        id: stringField(option.id, "model parameter id"),
        ...(optionalString(option.displayName)
          ? { displayName: optionalString(option.displayName) }
          : {}),
        values: option.values.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(
              "Cursor returned an invalid model parameter value.",
            );
          }
          const candidate = entry as Record<string, unknown>;
          return {
            value: stringField(candidate.value, "model parameter value"),
            ...(optionalString(candidate.displayName)
              ? { displayName: optionalString(candidate.displayName) }
              : {}),
          };
        }),
      };
    }),
    variants: variants.map((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
        throw new Error("Cursor returned an invalid model variant.");
      }
      const candidate = variant as Record<string, unknown>;
      if (!Array.isArray(candidate.params)) {
        throw new Error("Cursor returned invalid model variant parameters.");
      }
      return {
        params: candidate.params.map(parameterValueFrom),
        displayName: stringField(
          candidate.displayName,
          "model variant display name",
        ),
        ...(optionalString(candidate.description)
          ? { description: optionalString(candidate.description) }
          : {}),
        ...(typeof candidate.isDefault === "boolean"
          ? { isDefault: candidate.isDefault }
          : {}),
      };
    }),
  };
}

function safeMessage(
  body: unknown,
  status: number,
): { message: string; code?: string } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const row = body as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : undefined;
    const message =
      typeof row.message === "string"
        ? row.message
        : typeof row.error === "string"
          ? row.error
          : undefined;
    if (message) return { message, ...(code ? { code } : {}) };
  }
  return { message: `Cursor returned HTTP ${status}.` };
}

export function createCursorClient(options?: {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): CursorClient {
  const requestFetch = options?.fetch ?? fetch;
  const baseUrl = (options?.baseUrl ?? CURSOR_API_BASE).replace(/\/$/, "");
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const request = async (
    apiKey: string,
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const response = await requestFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const body = text
      ? (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return null;
          }
        })()
      : null;
    if (!response.ok) {
      const detail = safeMessage(body, response.status);
      throw new CursorApiError(detail.message, response.status, detail.code);
    }
    return body;
  };

  return {
    async keyInfo(apiKey) {
      const value = await request(apiKey, "/v1/me");
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Cursor returned invalid API key information.");
      }
      const row = value as Record<string, unknown>;
      return {
        apiKeyName: stringField(row.apiKeyName, "API key name"),
        ...(typeof row.createdAt === "string"
          ? { createdAt: row.createdAt }
          : {}),
        ...(typeof row.userEmail === "string"
          ? { userEmail: row.userEmail }
          : {}),
      };
    },

    async listModels(apiKey) {
      const value = await request(apiKey, "/v1/models");
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Cursor returned an invalid model list.");
      }
      const items = (value as Record<string, unknown>).items;
      if (!Array.isArray(items)) {
        throw new Error("Cursor returned an invalid model list.");
      }
      return items.map(modelFrom);
    },

    async createAgent(apiKey, input) {
      const value = await request(apiKey, "/v1/agents", {
        method: "POST",
        body: JSON.stringify({
          agentId: input.agentId,
          name: input.name.slice(0, 100),
          prompt: { text: input.prompt },
          repos: [
            {
              url: input.repositoryUrl,
              ...(input.startingRef ? { startingRef: input.startingRef } : {}),
            },
          ],
          ...(input.model ? { model: input.model } : {}),
          workOnCurrentBranch: false,
          autoCreatePR: input.autoCreatePR,
        }),
      });
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Cursor returned an invalid create response.");
      }
      const row = value as Record<string, unknown>;
      return { agent: agentFrom(row.agent), run: runFrom(row.run) };
    },

    async getAgent(apiKey, agentId) {
      return agentFrom(
        await request(apiKey, `/v1/agents/${encodeURIComponent(agentId)}`),
      );
    },

    async createRun(apiKey, agentId, prompt) {
      const value = await request(
        apiKey,
        `/v1/agents/${encodeURIComponent(agentId)}/runs`,
        { method: "POST", body: JSON.stringify({ prompt: { text: prompt } }) },
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Cursor returned an invalid follow-up response.");
      }
      return runFrom((value as Record<string, unknown>).run);
    },

    async getRun(apiKey, agentId, runId) {
      return runFrom(
        await request(
          apiKey,
          `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
        ),
      );
    },

    async cancelRun(apiKey, agentId, runId) {
      await request(
        apiKey,
        `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
    },
  };
}
