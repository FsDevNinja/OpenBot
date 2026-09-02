import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { providerConnectionKeys, type ProviderOAuthSession } from "./queries";

export async function invalidateProviders(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: providerConnectionKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.capabilities() }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  ]);
}

export function startProviderOAuthMutationOptions() {
  return mutationOptions({
    mutationFn: (providerId: string): Promise<ProviderOAuthSession> =>
      client(
        `/api/provider-connections/${encodeURIComponent(providerId)}/oauth/start`,
        "authorization",
        {
          method: "POST",
          body: {},
          fallback: "That provider authorization could not be started.",
        },
      ),
  });
}

export function cancelProviderOAuthMutationOptions() {
  return mutationOptions({
    mutationFn: (input: { providerId: string; sessionId: string }) =>
      client(
        `/api/provider-connections/${encodeURIComponent(input.providerId)}/oauth/${encodeURIComponent(input.sessionId)}`,
        {
          method: "DELETE",
          fallback: "That provider authorization could not be cancelled.",
        },
      ),
  });
}

export function connectProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: { providerId: string; credential?: string }) =>
      client(
        `/api/provider-connections/${encodeURIComponent(input.providerId)}`,
        {
          method: "PUT",
          body: input.credential ? { credential: input.credential } : {},
          fallback: "That provider could not be connected.",
        },
      ),
    onSuccess: () => invalidateProviders(queryClient),
  });
}

export function disconnectProviderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (providerId: string) =>
      client(`/api/provider-connections/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
        fallback: "That provider could not be disconnected.",
      }),
    onSuccess: () => invalidateProviders(queryClient),
  });
}
