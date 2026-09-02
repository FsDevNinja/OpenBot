import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const providerConnectionKeys = {
  all: ["provider-connections"] as const,
  list: () => ["provider-connections", "list"] as const,
};

export type ProviderConnection = {
  id: string;
  name: string;
  description: string;
  authentication: "oauth" | "api-key";
  runtimeAvailable: boolean;
  connected: boolean;
  available: boolean;
};

export function providerConnectionsQueryOptions() {
  return queryOptions({
    queryKey: providerConnectionKeys.list(),
    queryFn: (): Promise<ProviderConnection[]> =>
      client("/api/provider-connections", "providers", {
        fallback: "Could not load your AI providers",
      }),
  });
}

export type ProviderOAuthSession = {
  sessionId: string;
  verificationUrl: string;
  userCode: string;
};

export type ProviderOAuthStatus =
  | { status: "pending" }
  | { status: "connected"; provider: ProviderConnection }
  | { status: "failed"; error: string };

export function providerOAuthStatusQueryOptions(
  providerId: string,
  sessionId: string,
) {
  return queryOptions({
    queryKey: [...providerConnectionKeys.all, "oauth", providerId, sessionId],
    queryFn: (): Promise<ProviderOAuthStatus> =>
      client(
        `/api/provider-connections/${encodeURIComponent(providerId)}/oauth/${encodeURIComponent(sessionId)}`,
        "authorization",
        {
          fallback: "Could not check provider authorization",
        },
      ),
    enabled: Boolean(providerId && sessionId),
    refetchInterval: (query) =>
      query.state.data?.status === "connected" ||
      query.state.data?.status === "failed"
        ? false
        : 1_500,
  });
}
