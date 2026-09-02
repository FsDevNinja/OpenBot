import type { AgentProviderId, AgentProviderRuntime } from "./providers";

export type ProviderOAuthStart = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

export type ProviderOAuthRuntimeStatus =
  | { status: "pending" }
  | { status: "connected" }
  | { status: "failed"; error: string };

export type ProviderOAuthBroker = {
  start(
    providerId: AgentProviderId,
    connectionId: string,
  ): Promise<ProviderOAuthStart>;
  status(
    providerId: AgentProviderId,
    connectionId: string,
    loginId: string,
  ): Promise<ProviderOAuthRuntimeStatus>;
  cancel(
    providerId: AgentProviderId,
    connectionId: string,
    loginId: string,
  ): Promise<void>;
  disconnect(providerId: AgentProviderId, connectionId: string): Promise<void>;
};

export class ProviderOAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOAuthUnavailableError";
  }
}

/**
 * Talks only to deployment-managed provider adapters.
 *
 * The adapter owns the vendor OAuth tokens. OpenBot stores an opaque locator for the account, and
 * the runtime token authenticates every call across this internal boundary.
 */
export function createProviderOAuthBroker(
  runtimes: readonly AgentProviderRuntime[],
  fetcher: typeof fetch = fetch,
): ProviderOAuthBroker {
  const runtimeFor = (providerId: AgentProviderId) => {
    const runtime = runtimes.find((candidate) => candidate.id === providerId);
    if (!runtime) {
      throw new ProviderOAuthUnavailableError(
        `This deployment does not have a ${providerId} runtime.`,
      );
    }
    return runtime;
  };

  const request = async (
    providerId: AgentProviderId,
    path: string,
    init: RequestInit,
  ): Promise<unknown> => {
    const runtime = runtimeFor(providerId);
    const response = await fetcher(runtimeUrl(runtime.endpoint, path), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": runtime.token,
        ...init.headers,
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
    };
    if (!response.ok) {
      throw new ProviderOAuthUnavailableError(
        typeof body.error === "string"
          ? body.error
          : "The provider authorization service did not accept the request.",
      );
    }
    return body;
  };

  return {
    async start(providerId, connectionId) {
      const body = (await request(providerId, "/auth/login/start", {
        method: "POST",
        body: JSON.stringify({ connectionId }),
      })) as Partial<ProviderOAuthStart>;
      if (
        typeof body.loginId !== "string" ||
        typeof body.verificationUrl !== "string" ||
        typeof body.userCode !== "string"
      ) {
        throw new ProviderOAuthUnavailableError(
          "The provider authorization service returned an invalid login response.",
        );
      }
      return {
        loginId: body.loginId,
        verificationUrl: body.verificationUrl,
        userCode: body.userCode,
      };
    },

    async status(providerId, connectionId, loginId) {
      const query = new URLSearchParams({ connectionId, loginId });
      const body = (await request(
        providerId,
        `/auth/login/status?${query.toString()}`,
        { method: "GET" },
      )) as { status?: unknown; error?: unknown };
      if (body.status === "pending" || body.status === "connected") {
        return { status: body.status };
      }
      if (body.status === "failed") {
        return {
          status: "failed",
          error:
            typeof body.error === "string"
              ? body.error
              : "Provider authorization failed.",
        };
      }
      throw new ProviderOAuthUnavailableError(
        "The provider authorization service returned an invalid status.",
      );
    },

    async cancel(providerId, connectionId, loginId) {
      await request(providerId, "/auth/login/cancel", {
        method: "POST",
        body: JSON.stringify({ connectionId, loginId }),
      });
    },

    async disconnect(providerId, connectionId) {
      await request(
        providerId,
        `/auth/connections/${encodeURIComponent(connectionId)}`,
        { method: "DELETE" },
      );
    },
  };
}

function runtimeUrl(endpoint: URL, path: string): URL {
  const url = new URL(endpoint);
  const target = new URL(path, url.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = "";
  return url;
}
