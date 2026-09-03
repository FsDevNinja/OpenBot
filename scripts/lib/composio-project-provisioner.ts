import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_COMPOSIO_API_BASE_URL = "https://backend.composio.dev";
const PROJECTS_PATH = "/api/v3.1/org/owner/project";

export type ComposioProject = {
  id: string;
  name: string;
};

export type CreatedComposioProject = ComposioProject & {
  apiKey: string;
};

export type StoredComposioProject = ComposioProject & {
  deploymentId: string;
  hasApiKey: true;
};

export type ComposioOrganizationClient = {
  listProjects(cursor?: string): Promise<{
    projects: ComposioProject[];
    nextCursor?: string;
  }>;
  createProject(name: string): Promise<CreatedComposioProject>;
};

export type ComposioUsageEntity = {
  unit: string;
  totalQuantity: string;
  eventCount: number;
};

export type ComposioOrganizationUsageClient = {
  usageSummary(input: {
    projectId: string;
    from: number;
    to: number;
  }): Promise<{
    toolCalls?: ComposioUsageEntity;
    sessions?: ComposioUsageEntity;
  }>;
};

/** A secret manager in production, and a mode-0600 env file for local deployment work. */
export type ComposioProjectSecretSink = {
  load(): Promise<StoredComposioProject | undefined>;
  save(project: CreatedComposioProject): Promise<void>;
};

export class ComposioProvisioningError extends Error {}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function slug(value: string, field: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (!normalized) {
    throw new ComposioProvisioningError(
      `${field} must contain a letter or number.`,
    );
  }
  return normalized;
}

/**
 * A readable, deterministic identifier shared by OpenBot's deployment boundary and the Composio
 * project. The hash keeps different source ids distinct after slugging or truncation.
 */
export function composioDeploymentId(
  workspaceId: string,
  environment: string,
): string {
  const identity = `${workspaceId.trim()}\0${environment.trim()}`;
  const suffix = hash(identity).slice(0, 10);
  const readable = `${slug(workspaceId, "workspace id")}-${slug(
    environment,
    "environment",
  )}`;
  return `openbot-${readable.slice(0, 42).replace(/-+$/g, "")}-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFrom(value: unknown): ComposioProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    throw new ComposioProvisioningError(
      "Composio returned a project without a valid id and name.",
    );
  }
  return { id: value.id, name: value.name };
}

function errorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.message === "string") return value.message.slice(0, 500);
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message.slice(0, 500);
  }
  return undefined;
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.replaceAll(secret, "[redacted]") : safe),
    text,
  );
}

async function responseJson(
  response: Response,
  action: string,
  secrets: readonly string[] = [],
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = errorDetail(body);
    throw new ComposioProvisioningError(
      `${action} failed with Composio HTTP ${response.status}${
        detail ? `: ${redact(detail, secrets)}` : "."
      }`,
    );
  }
  return body;
}

/** Organization API calls live here so the OpenBot server never imports or reads the org key. */
export function createComposioOrganizationClient(input: {
  organizationApiKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): ComposioOrganizationClient & ComposioOrganizationUsageClient {
  const organizationApiKey = input.organizationApiKey.trim();
  if (!organizationApiKey) {
    throw new ComposioProvisioningError(
      "COMPOSIO_ORG_API_KEY is required by the provisioning command.",
    );
  }
  const apiBaseUrl = (
    input.apiBaseUrl ?? DEFAULT_COMPOSIO_API_BASE_URL
  ).replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    "x-org-api-key": organizationApiKey,
    "content-type": "application/json",
  };

  return {
    async listProjects(cursor) {
      const url = new URL(`${apiBaseUrl}${PROJECTS_PATH}/list`);
      url.searchParams.set("limit", "50");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = await responseJson(
        await fetchImpl(url, { headers }),
        "Listing organization projects",
        [organizationApiKey],
      );
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new ComposioProvisioningError(
          "Composio returned an invalid project list.",
        );
      }
      const nextCursor = body.next_cursor;
      if (nextCursor != null && typeof nextCursor !== "string") {
        throw new ComposioProvisioningError(
          "Composio returned an invalid project-list cursor.",
        );
      }
      return {
        projects: body.data.map(projectFrom),
        ...(nextCursor ? { nextCursor } : {}),
      };
    },

    async createProject(name) {
      const body = await responseJson(
        await fetchImpl(`${apiBaseUrl}${PROJECTS_PATH}/new`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name, should_create_api_key: true }),
        }),
        `Creating Composio project ${name}`,
        [organizationApiKey],
      );
      const project = projectFrom(body);
      if (project.name !== name) {
        throw new ComposioProvisioningError(
          `Composio created project ${project.name} instead of ${name}.`,
        );
      }
      if (
        !isRecord(body) ||
        typeof body.api_key !== "string" ||
        !body.api_key.startsWith("ak_")
      ) {
        throw new ComposioProvisioningError(
          "Composio created the project but did not return a usable project API key. Rotate its key in Composio before using the deployment.",
        );
      }
      return { ...project, apiKey: body.api_key };
    },

    async usageSummary({ projectId, from, to }) {
      if (!/^[A-Za-z0-9._-]+$/.test(projectId)) {
        throw new ComposioProvisioningError(
          "A valid Composio project id is required.",
        );
      }
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to <= from ||
        to - from > 366 * 24 * 60 * 60 * 1_000
      ) {
        throw new ComposioProvisioningError(
          "Usage requires a valid exclusive time range of no more than 366 days.",
        );
      }
      const body = await responseJson(
        await fetchImpl(`${apiBaseUrl}/api/v3.1/org/usage/summary`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            from,
            to,
            entity_types: ["tool_calls", "sessions"],
            filters: { project_id: projectId },
          }),
        }),
        `Reading usage for Composio project ${projectId}`,
        [organizationApiKey],
      );
      if (!isRecord(body) || !isRecord(body.entities)) {
        throw new ComposioProvisioningError(
          "Composio returned an invalid usage summary.",
        );
      }
      const parseEntity = (value: unknown): ComposioUsageEntity | undefined => {
        if (value === undefined) return undefined;
        if (
          !isRecord(value) ||
          typeof value.unit !== "string" ||
          typeof value.total_quantity !== "string" ||
          typeof value.event_count !== "number" ||
          !Number.isSafeInteger(value.event_count) ||
          value.event_count < 0
        ) {
          throw new ComposioProvisioningError(
            "Composio returned an invalid usage entity.",
          );
        }
        return {
          unit: value.unit,
          totalQuantity: value.total_quantity,
          eventCount: value.event_count,
        };
      };
      const toolCalls = parseEntity(body.entities.tool_calls);
      const sessions = parseEntity(body.entities.sessions);
      return {
        ...(toolCalls ? { toolCalls } : {}),
        ...(sessions ? { sessions } : {}),
      };
    },
  };
}

async function findProject(
  client: ComposioOrganizationClient,
  name: string,
): Promise<ComposioProject | undefined> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 1_000; page += 1) {
    const result = await client.listProjects(cursor);
    const found = result.projects.find((project) => project.name === name);
    if (found) return found;
    if (!result.nextCursor) return undefined;
    if (seenCursors.has(result.nextCursor)) {
      throw new ComposioProvisioningError(
        "Composio repeated a project-list cursor; provisioning stopped before creating anything.",
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ComposioProvisioningError(
    "Composio project pagination exceeded the safety limit; provisioning stopped before creating anything.",
  );
}

export async function provisionComposioProject(input: {
  client: ComposioOrganizationClient;
  deploymentId: string;
  sink: ComposioProjectSecretSink;
}): Promise<{
  status: "created" | "already-provisioned";
  project: ComposioProject;
}> {
  const projectName = input.deploymentId;
  const stored = await input.sink.load();
  if (
    stored &&
    (stored.name !== projectName || stored.deploymentId !== input.deploymentId)
  ) {
    throw new ComposioProvisioningError(
      "The existing secret file does not describe this deployment. Nothing was changed.",
    );
  }
  if (stored) {
    return {
      status: "already-provisioned",
      project: { id: stored.id, name: stored.name },
    };
  }

  const remote = await findProject(input.client, projectName);
  if (remote) {
    throw new ComposioProvisioningError(
      `Composio project ${projectName} already exists, but its full API key is not in this secret destination. OpenBot will not rotate a live key automatically; create a project key in Composio and install it through your secret manager.`,
    );
  }

  const created = await input.client.createProject(projectName);
  try {
    await input.sink.save(created);
  } catch (error) {
    const detail = redact(
      error instanceof Error ? error.message : String(error),
      [created.apiKey],
    );
    throw new ComposioProvisioningError(
      `Composio project ${created.name} was created, but its key could not be saved${
        detail ? `: ${detail}` : "."
      } Rotate that project's key in Composio before retrying; the original key is intentionally not printed.`,
    );
  }
  return {
    status: "created",
    project: { id: created.id, name: created.name },
  };
}

function parseSecretFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new ComposioProvisioningError(
        "The Composio secret file contains an invalid line.",
      );
    }
    const key = trimmed.slice(0, separator);
    if (key in values) {
      throw new ComposioProvisioningError(
        `The Composio secret file contains duplicate ${key} entries.`,
      );
    }
    values[key] = trimmed.slice(separator + 1);
  }
  return values;
}

function safeEnvValue(value: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new ComposioProvisioningError(
      `${field} contains characters that cannot be written safely to an env file.`,
    );
  }
  return value;
}

/**
 * A dedicated deployment env fragment. It refuses to overwrite and uses a same-directory hard link
 * so two concurrent provisioners cannot silently replace each other's secret.
 */
export function createEnvFileSecretSink(input: {
  path: string;
  deploymentId: string;
}): ComposioProjectSecretSink {
  return {
    async load() {
      let contents: string;
      try {
        const details = await lstat(input.path);
        if (!details.isFile()) {
          throw new ComposioProvisioningError(
            `Refusing to read ${input.path}: the connector secret destination must be a regular file.`,
          );
        }
        if ((details.mode & 0o077) !== 0) {
          throw new ComposioProvisioningError(
            `Refusing to read ${input.path}: connector secret files must have mode 0600.`,
          );
        }
        contents = await readFile(input.path, "utf8");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
      const values = parseSecretFile(contents);
      const deploymentId = values.DEPLOYMENT_ID;
      const id = values.COMPOSIO_PROJECT_ID;
      const name = values.COMPOSIO_PROJECT_NAME;
      const apiKey = values.COMPOSIO_API_KEY;
      if (!deploymentId || !id || !name || !apiKey?.startsWith("ak_")) {
        throw new ComposioProvisioningError(
          `${input.path} is not a complete OpenBot Composio deployment secret file.`,
        );
      }
      safeEnvValue(deploymentId, "deployment id");
      safeEnvValue(id, "Composio project id");
      safeEnvValue(name, "Composio project name");
      safeEnvValue(apiKey, "Composio project API key");
      return { deploymentId, id, name, hasApiKey: true };
    },

    async save(project) {
      const deploymentId = safeEnvValue(input.deploymentId, "deployment id");
      const id = safeEnvValue(project.id, "Composio project id");
      const name = safeEnvValue(project.name, "Composio project name");
      const apiKey = safeEnvValue(project.apiKey, "Composio project API key");
      const contents = [
        "# Generated by OpenBot's Composio project provisioner. Keep this file secret.",
        `DEPLOYMENT_ID=${deploymentId}`,
        `COMPOSIO_PROJECT_ID=${id}`,
        `COMPOSIO_PROJECT_NAME=${name}`,
        `COMPOSIO_API_KEY=${apiKey}`,
        "",
      ].join("\n");
      await mkdir(dirname(input.path), { recursive: true });
      const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, contents, { flag: "wx", mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await link(temporaryPath, input.path);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    },
  };
}
