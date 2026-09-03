import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComposioProvisioningError,
  composioDeploymentId,
  createComposioOrganizationClient,
  createEnvFileSecretSink,
  provisionComposioProject,
  type ComposioOrganizationClient,
  type ComposioProjectSecretSink,
  type StoredComposioProject,
} from "../scripts/lib/composio-project-provisioner";

function memorySink(stored?: StoredComposioProject): {
  sink: ComposioProjectSecretSink;
  saved: Array<{ id: string; name: string; apiKey: string }>;
} {
  const saved: Array<{ id: string; name: string; apiKey: string }> = [];
  return {
    saved,
    sink: {
      async load() {
        return stored;
      },
      async save(project) {
        saved.push(project);
      },
    },
  };
}

describe("Composio project provisioning", () => {
  test("derives a stable deployment id without collisions after slugging", () => {
    const id = composioDeploymentId("Customer 42", "Production");

    expect(id).toMatch(/^openbot-customer-42-production-[a-f0-9]{10}$/);
    expect(id).toBe(composioDeploymentId("Customer 42", "Production"));
    expect(id).not.toBe(composioDeploymentId("Customer-42", "Production"));
    expect(
      composioDeploymentId("x".repeat(200), "production").length,
    ).toBeLessThanOrEqual(61);
    expect(() => composioDeploymentId("!!!", "production")).toThrow(
      "workspace id",
    );
  });

  test("creates one project and hands its key directly to the secret sink", async () => {
    const calls: string[] = [];
    const client: ComposioOrganizationClient = {
      async listProjects() {
        calls.push("list");
        return { projects: [] };
      },
      async createProject(name) {
        calls.push(`create:${name}`);
        return { id: "pr_acme", name, apiKey: "ak_project_secret" };
      },
    };
    const { sink, saved } = memorySink();

    await expect(
      provisionComposioProject({
        client,
        deploymentId: "openbot-acme-production-abcd123456",
        sink,
      }),
    ).resolves.toEqual({
      status: "created",
      project: {
        id: "pr_acme",
        name: "openbot-acme-production-abcd123456",
      },
    });
    expect(calls).toEqual([
      "list",
      "create:openbot-acme-production-abcd123456",
    ]);
    expect(saved).toEqual([
      {
        id: "pr_acme",
        name: "openbot-acme-production-abcd123456",
        apiKey: "ak_project_secret",
      },
    ]);
  });

  test("uses a complete local deployment secret as the idempotency marker", async () => {
    const project = {
      id: "pr_acme",
      name: "openbot-acme-production-abcd123456",
    };
    let created = false;
    const client: ComposioOrganizationClient = {
      async listProjects() {
        throw new Error("an idempotent rerun must not call Composio");
      },
      async createProject() {
        created = true;
        return { ...project, apiKey: "ak_should_not_be_created" };
      },
    };
    const { sink, saved } = memorySink({
      ...project,
      deploymentId: project.name,
      hasApiKey: true,
    });

    await expect(
      provisionComposioProject({ client, deploymentId: project.name, sink }),
    ).resolves.toEqual({ status: "already-provisioned", project });
    expect(created).toBe(false);
    expect(saved).toEqual([]);
  });

  test("will not rotate an existing project's key when the destination lost it", async () => {
    const name = "openbot-acme-production-abcd123456";
    let created = false;
    const client: ComposioOrganizationClient = {
      async listProjects() {
        return { projects: [{ id: "pr_acme", name }] };
      },
      async createProject() {
        created = true;
        return { id: "unexpected", name, apiKey: "ak_unexpected" };
      },
    };

    await expect(
      provisionComposioProject({
        client,
        deploymentId: name,
        sink: memorySink().sink,
      }),
    ).rejects.toThrow("will not rotate a live key automatically");
    expect(created).toBe(false);
  });

  test("uses the organization header only at the admin API boundary and redacts it", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const organizationApiKey = "org-super-secret";
    const client = createComposioOrganizationClient({
      organizationApiKey,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ error: { message: `bad ${organizationApiKey}` } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    let message = "";
    try {
      await client.listProjects();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 401");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(organizationApiKey);
    expect(requests[0]?.init?.headers).toEqual({
      "x-org-api-key": organizationApiKey,
      "content-type": "application/json",
    });
  });

  test("treats Composio's null cursor as the end of the project list", async () => {
    const client = createComposioOrganizationClient({
      organizationApiKey: "org-test-key",
      fetchImpl: (async () =>
        Response.json({
          data: [{ id: "pr_existing", name: "existing-project" }],
          next_cursor: null,
        })) as typeof fetch,
    });

    await expect(client.listProjects()).resolves.toEqual({
      projects: [{ id: "pr_existing", name: "existing-project" }],
    });
  });

  test("asks Composio to return a project key without sending the org key in the body", async () => {
    const organizationApiKey = "org-super-secret";
    let requestBody = "";
    const client = createComposioOrganizationClient({
      organizationApiKey,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          "x-org-api-key": organizationApiKey,
          "content-type": "application/json",
        });
        return Response.json({
          id: "pr_acme",
          name: "openbot-acme-production-abcd123456",
          api_key: "ak_project_secret",
        });
      }) as typeof fetch,
    });

    await expect(
      client.createProject("openbot-acme-production-abcd123456"),
    ).resolves.toEqual({
      id: "pr_acme",
      name: "openbot-acme-production-abcd123456",
      apiKey: "ak_project_secret",
    });
    expect(JSON.parse(requestBody)).toEqual({
      name: "openbot-acme-production-abcd123456",
      should_create_api_key: true,
    });
    expect(requestBody).not.toContain(organizationApiKey);
  });

  test("meters only the requested customer project with organization authority", async () => {
    const organizationApiKey = "org-super-secret";
    let requestBody = "";
    const client = createComposioOrganizationClient({
      organizationApiKey,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toEndWith("/api/v3.1/org/usage/summary");
        expect(init?.headers).toEqual({
          "x-org-api-key": organizationApiKey,
          "content-type": "application/json",
        });
        requestBody = String(init?.body ?? "");
        return Response.json({
          entities: {
            tool_calls: {
              unit: "count",
              total_quantity: "142",
              event_count: 142,
            },
            sessions: {
              unit: "count",
              total_quantity: "8",
              event_count: 8,
            },
          },
        });
      }) as typeof fetch,
    });
    const from = Date.parse("2026-08-01T00:00:00.000Z");
    const to = Date.parse("2026-09-01T00:00:00.000Z");

    await expect(
      client.usageSummary({ projectId: "pr_acme", from, to }),
    ).resolves.toEqual({
      toolCalls: { unit: "count", totalQuantity: "142", eventCount: 142 },
      sessions: { unit: "count", totalQuantity: "8", eventCount: 8 },
    });
    expect(JSON.parse(requestBody)).toEqual({
      from,
      to,
      entity_types: ["tool_calls", "sessions"],
      filters: { project_id: "pr_acme" },
    });
    expect(requestBody).not.toContain(organizationApiKey);
  });

  test("redacts the new project key if its secret sink fails", async () => {
    const apiKey = "ak_project_secret";
    const client: ComposioOrganizationClient = {
      async listProjects() {
        return { projects: [] };
      },
      async createProject(name) {
        return { id: "pr_acme", name, apiKey };
      },
    };
    const sink: ComposioProjectSecretSink = {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error(`failed while handling ${apiKey}`);
      },
    };

    let message = "";
    try {
      await provisionComposioProject({
        client,
        deploymentId: "openbot-acme-production-abcd123456",
        sink,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(apiKey);
  });

  test("writes a dedicated mode-0600 env fragment and never overwrites it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-composio-"));
    const path = join(directory, ".env.composio");
    const deploymentId = "openbot-acme-production-abcd123456";
    const sink = createEnvFileSecretSink({ path, deploymentId });
    try {
      await sink.save({
        id: "pr_acme",
        name: deploymentId,
        apiKey: "ak_project_secret",
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await sink.load()).toEqual({
        id: "pr_acme",
        name: deploymentId,
        deploymentId,
        hasApiKey: true,
      });
      expect(await readFile(path, "utf8")).toContain(
        "COMPOSIO_API_KEY=ak_project_secret",
      );

      await expect(
        sink.save({
          id: "pr_other",
          name: deploymentId,
          apiKey: "ak_other_secret",
        }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).not.toContain("ak_other_secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("refuses to load a connector secret file readable by other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-composio-"));
    const path = join(directory, ".env.composio");
    try {
      await writeFile(path, "COMPOSIO_API_KEY=ak_secret\n", { mode: 0o644 });
      await expect(
        createEnvFileSecretSink({
          path,
          deploymentId: "openbot-acme-production-abcd123456",
        }).load(),
      ).rejects.toBeInstanceOf(ComposioProvisioningError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
