import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type CloudAgentProvider,
  type CloudAgentTask,
  cloudAgentKeys,
} from "./queries";

export function connectCloudAgentProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: { providerId: string; credential: string }) =>
      client<CloudAgentProvider>(
        `/api/cloud-agent-providers/${encodeURIComponent(input.providerId)}`,
        "provider",
        {
          method: "PUT",
          body: { credential: input.credential },
          fallback: "That cloud-agent provider could not be connected.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudAgentKeys.all }),
  });
}

export function disconnectCloudAgentProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (providerId: string) =>
      client(`/api/cloud-agent-providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
        fallback: "That cloud-agent provider could not be disconnected.",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: cloudAgentKeys.all }),
  });
}

export function cancelCloudAgentTaskMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (taskId: string) =>
      client<CloudAgentTask>(
        `/api/cloud-agent-tasks/${encodeURIComponent(taskId)}/cancel`,
        "task",
        {
          method: "POST",
          body: {},
          fallback: "That cloud development task could not be cancelled.",
        },
      ),
    onSuccess: (task) =>
      queryClient.setQueryData(cloudAgentKeys.task(task.id), task),
  });
}
