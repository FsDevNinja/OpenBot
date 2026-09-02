import { useRenderTool } from "@copilotkit/react-core/v2";
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCloudCode,
  IconExternalLink,
  IconGitBranch,
  IconGitPullRequest,
  IconLoader2,
  IconPlayerStopFilled,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { Button } from "@/components/ui/button";
import { cancelCloudAgentTaskMutationOptions } from "@/lib/cloud-agents/mutations";
import {
  type CloudAgentModelSelection,
  type CloudAgentTask,
  type CloudAgentTaskStatus,
  cloudAgentTaskQueryOptions,
  isActiveCloudAgentTask,
} from "@/lib/cloud-agents/queries";
import { asText } from "@/lib/plugins/tool-result";
import { cn } from "@/lib/utils";

const startParameters = z.object({
  title: z.string().optional(),
  repositoryUrl: z.string().optional(),
  startingRef: z.string().optional(),
  model: z
    .object({
      id: z.string().optional(),
      params: z
        .array(
          z.object({ id: z.string().optional(), value: z.string().optional() }),
        )
        .optional(),
    })
    .optional(),
  instruction: z.string().optional(),
});
const listParameters = z.object({});
const updateParameters = z.object({
  taskId: z.string().optional(),
  instruction: z.string().optional(),
});
const taskParameters = z.object({ taskId: z.string().optional() });

export type CloudAgentTaskSeed = Pick<
  CloudAgentTask,
  | "id"
  | "title"
  | "repositoryUrl"
  | "model"
  | "status"
  | "remoteUrl"
  | "branch"
  | "pullRequestUrl"
  | "result"
  | "lastError"
>;

function modelFrom(value: unknown): CloudAgentModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.displayName !== "string" ||
    !Array.isArray(candidate.params)
  ) {
    return null;
  }
  const params = candidate.params.flatMap((parameter) => {
    if (
      !parameter ||
      typeof parameter !== "object" ||
      Array.isArray(parameter)
    ) {
      return [];
    }
    const option = parameter as Record<string, unknown>;
    return typeof option.id === "string" && typeof option.value === "string"
      ? [{ id: option.id, value: option.value }]
      : [];
  });
  if (params.length !== candidate.params.length) return null;
  return { id: candidate.id, displayName: candidate.displayName, params };
}

function safeExternalUrl(
  value: unknown,
  allowedHostname: (hostname: string) => boolean,
): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHostname(url.hostname)
      ? value
      : null;
  } catch {
    return null;
  }
}

const isCursorHostname = (hostname: string) =>
  hostname === "cursor.com" || hostname.endsWith(".cursor.com");
const isGitHubHostname = (hostname: string) => hostname === "github.com";

export function seedFrom(result: unknown): CloudAgentTaskSeed | null {
  if (typeof result !== "string") return null;
  try {
    const value = JSON.parse(asText(result)) as Record<string, unknown>;
    if (typeof value.taskId !== "string") return null;
    return {
      id: value.taskId,
      title:
        typeof value.title === "string"
          ? value.title
          : "Cloud development task",
      repositoryUrl:
        typeof value.repositoryUrl === "string" ? value.repositoryUrl : "",
      model: modelFrom(value.model),
      status:
        typeof value.status === "string"
          ? (value.status as CloudAgentTaskStatus)
          : "submitting",
      remoteUrl: safeExternalUrl(value.remoteUrl, isCursorHostname),
      branch: typeof value.branch === "string" ? value.branch : null,
      pullRequestUrl: safeExternalUrl(value.pullRequestUrl, isGitHubHostname),
      result: typeof value.result === "string" ? value.result : null,
      lastError: typeof value.error === "string" ? value.error : null,
    };
  } catch {
    return null;
  }
}

const STATUS: Record<
  CloudAgentTaskStatus,
  { label: string; className: string }
> = {
  submitting: {
    label: "Starting",
    className: "text-sky-700 dark:text-sky-400",
  },
  queued: { label: "Queued", className: "text-sky-700 dark:text-sky-400" },
  running: { label: "Working", className: "text-sky-700 dark:text-sky-400" },
  succeeded: {
    label: "Completed",
    className: "text-emerald-700 dark:text-emerald-400",
  },
  failed: { label: "Failed", className: "text-destructive" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground" },
  expired: {
    label: "Expired",
    className: "text-amber-700 dark:text-amber-400",
  },
  submission_uncertain: {
    label: "Checking submission",
    className: "text-amber-700 dark:text-amber-400",
  },
};

function StatusIcon({ status }: { status: CloudAgentTaskStatus }) {
  const className = "size-4";
  if (isActiveCloudAgentTask(status)) {
    return <IconLoader2 className={cn(className, "animate-spin")} />;
  }
  if (status === "succeeded") return <IconCircleCheck className={className} />;
  if (status === "cancelled") return <IconBan className={className} />;
  return <IconAlertTriangle className={className} />;
}

function repositoryName(url: string) {
  return (
    url
      .replace(/\.git\/?$/, "")
      .split("/")
      .slice(-2)
      .join("/") || url
  );
}

export function CloudTaskCard({ seed }: { seed: CloudAgentTaskSeed }) {
  const queryClient = useQueryClient();
  const query = useQuery(cloudAgentTaskQueryOptions(seed.id));
  const cancel = useMutation(cancelCloudAgentTaskMutationOptions(queryClient));
  const task = query.data ?? seed;
  const status = STATUS[task.status] ?? STATUS.running;
  const active = isActiveCloudAgentTask(task.status);
  const remoteUrl = safeExternalUrl(task.remoteUrl, isCursorHostname);
  const pullRequestUrl = safeExternalUrl(task.pullRequestUrl, isGitHubHostname);

  return (
    <article className="my-3 overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b bg-muted/25 px-4 py-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <IconCloudCode className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate font-medium text-sm">{task.title}</h3>
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium text-xs",
                status.className,
              )}
            >
              <StatusIcon status={task.status} />
              {status.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            Cursor Cloud Agent
            {task.model ? ` · ${task.model.displayName}` : ""} ·{" "}
            {repositoryName(task.repositoryUrl)}
          </p>
        </div>
      </div>

      <div className="grid gap-3 px-4 py-3 text-sm">
        {task.branch ? (
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
            <IconGitBranch className="size-4 shrink-0" />
            <span className="truncate font-mono">{task.branch}</span>
          </div>
        ) : active ? (
          <p className="text-muted-foreground text-xs">
            Cursor is preparing an isolated workspace and will push to a
            separate branch.
          </p>
        ) : null}

        {task.result ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed">
            {task.result}
          </p>
        ) : null}
        {task.lastError ? (
          <p className="text-destructive text-xs" role="alert">
            {task.lastError}
          </p>
        ) : null}
        {query.error ? (
          <p className="text-amber-700 text-xs dark:text-amber-400">
            Live progress is temporarily unavailable. The task is still
            recorded.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {remoteUrl ? (
            <Button
              size="sm"
              variant="outline"
              render={(props) => (
                <a
                  {...props}
                  href={remoteUrl}
                  rel="noreferrer"
                  target="_blank"
                />
              )}
            >
              Open in Cursor
              <IconExternalLink className="size-4" />
            </Button>
          ) : null}
          {pullRequestUrl ? (
            <Button
              size="sm"
              variant="outline"
              render={(props) => (
                <a
                  {...props}
                  href={pullRequestUrl}
                  rel="noreferrer"
                  target="_blank"
                />
              )}
            >
              <IconGitPullRequest className="size-4" />
              Open pull request
            </Button>
          ) : null}
          {active && task.remoteUrl ? (
            <Button
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(task.id)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconPlayerStopFilled className="size-4" />
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
        </div>
        {cancel.error ? (
          <p className="text-destructive text-xs" role="alert">
            {cancel.error.message}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function RenderTask({
  result,
  status,
  fallbackTitle,
  fallbackRepository,
}: {
  result: unknown;
  status: string;
  fallbackTitle?: string;
  fallbackRepository?: string;
}) {
  const seed = seedFrom(result);
  if (seed) return <CloudTaskCard seed={seed} />;
  if (status !== "complete") {
    return (
      <article className="my-3 rounded-xl border bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <IconLoader2 className="size-4 animate-spin text-sky-600" />
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">
              {fallbackTitle ?? "Starting cloud development task"}
            </p>
            {fallbackRepository ? (
              <p className="truncate text-muted-foreground text-xs">
                Cursor Cloud Agent · {repositoryName(fallbackRepository)}
              </p>
            ) : null}
          </div>
        </div>
      </article>
    );
  }
  return (
    <ToolLine
      failed
      label="Cloud development task"
      detail={
        typeof result === "string" ? asText(result) : "No task was created"
      }
    />
  );
}

export function CloudAgentTools() {
  useRenderTool({
    name: "delegate_development_task",
    parameters: startParameters,
    render: ({ parameters, result, status }) => (
      <RenderTask
        fallbackRepository={parameters?.repositoryUrl}
        fallbackTitle={parameters?.title}
        result={result}
        status={status}
      />
    ),
  });

  useRenderTool({
    name: "list_development_models",
    parameters: listParameters,
    render: ({ result, status }) => {
      if (status !== "complete") {
        return <ToolLine label="Checking Cursor models" running />;
      }
      try {
        const value = JSON.parse(asText(result)) as {
          models?: Array<{ displayName?: unknown }>;
        };
        const names = (value.models ?? []).flatMap((model) =>
          typeof model.displayName === "string" ? [model.displayName] : [],
        );
        return (
          <ToolLine
            detail={names.length > 0 ? names.join(", ") : "None available"}
            label="Checked Cursor models"
          />
        );
      } catch {
        return (
          <ToolLine
            detail={typeof result === "string" ? asText(result) : undefined}
            failed
            label="Check Cursor models"
          />
        );
      }
    },
  });

  useRenderTool({
    name: "update_development_task",
    parameters: updateParameters,
    render: ({ result, status }) => (
      <RenderTask result={result} status={status} />
    ),
  });

  useRenderTool({
    name: "cancel_development_task",
    parameters: taskParameters,
    render: ({ result, status }) => (
      <RenderTask result={result} status={status} />
    ),
  });

  useRenderTool({
    name: "get_development_task",
    parameters: taskParameters,
    render: ({ result, status }) => (
      <RenderTask result={result} status={status} />
    ),
  });

  return null;
}
