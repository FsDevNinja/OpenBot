import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type CloudAgentProvider = {
  id: "cursor";
  name: string;
  description: string;
  authentication: "api-key";
  connected: boolean;
  dashboardUrl: string;
};

export type CloudAgentTaskStatus =
  | "submitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "submission_uncertain";

export type CloudAgentModelSelection = {
  id: string;
  displayName: string;
  params: Array<{ id: string; value: string }>;
};

export type CloudAgentTask = {
  id: string;
  provider: "cursor";
  title: string;
  repositoryUrl: string;
  startingRef: string | null;
  model: CloudAgentModelSelection | null;
  status: CloudAgentTaskStatus;
  remoteUrl: string | null;
  result: string | null;
  branch: string | null;
  pullRequestUrl: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  runs: Array<{
    id: string;
    sequence: number;
    instruction: string;
    status: CloudAgentTaskStatus;
    remoteRunId: string | null;
  }>;
};

const active = new Set<CloudAgentTaskStatus>([
  "submitting",
  "queued",
  "running",
  "submission_uncertain",
]);

export const cloudAgentKeys = {
  all: ["cloud-agents"] as const,
  providers: () => ["cloud-agents", "providers"] as const,
  task: (id: string) => ["cloud-agents", "tasks", id] as const,
};

export function cloudAgentProvidersQueryOptions() {
  return queryOptions({
    queryKey: cloudAgentKeys.providers(),
    queryFn: (): Promise<CloudAgentProvider[]> =>
      client("/api/cloud-agent-providers", "providers", {
        fallback: "Could not load cloud-agent providers",
      }),
  });
}

export function cloudAgentTaskQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: cloudAgentKeys.task(taskId),
    queryFn: (): Promise<CloudAgentTask> =>
      client(`/api/cloud-agent-tasks/${encodeURIComponent(taskId)}`, "task", {
        fallback: "Could not refresh this cloud development task",
      }),
    enabled: Boolean(taskId),
    refetchInterval: (query) =>
      query.state.data && active.has(query.state.data.status) ? 5_000 : false,
  });
}

export function isActiveCloudAgentTask(status: CloudAgentTaskStatus) {
  return active.has(status);
}
