import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type ConnectorCapabilityLevel, pluginKeys } from "./queries";

/**
 * Writes against what a deployment has installed: MCP servers, skills, and which Bots carry them.
 *
 * Servers and skills are two kinds of the same thing here — a plugin the deployment holds and grants
 * — which is why one grant endpoint serves both and takes the kind as an argument rather than having
 * two of everything.
 */

/** A skill as the server accepts it. `global` is an administrator writing for everybody. */
export type SkillInput = {
  slug: string;
  title: string;
  summary?: string;
  instructions: string;
  global?: boolean;
  /**
   * The tools this skill says it needs, as `<serverId>/<toolName>` refs.
   *
   * Sent on every save, including empty, because the server replaces the set rather than merging
   * into it: omitting the field to mean "leave them alone" and sending `[]` to mean "clear them"
   * would be the same request from a form that just had its last one unticked.
   */
  tools?: string[];
};

/** A curated server from the catalogue, which supplies the URL. */
export type CuratedServerInput = {
  key: string;
  instanceHost?: string;
  credentialId?: string;
};

/**
 * A server somebody typed the URL of, which therefore has to pass the URL checks.
 *
 * `token` is carried through as the previous version did. It is already a credential by the time
 * this is sent — the id beside it is what the record keeps — so the server has no use for it.
 */
export type CustomServerInput = {
  id: string;
  title: string;
  url: string;
  token?: string;
  credentialId?: string;
};

/** Which kinds of plugin a grant can be about. */
export type PluginKind = "mcp" | "skill";

const FALLBACK = "That did not work.";

/**
 * Refetch everything the plugin screens read.
 *
 * Exported because a bulk grant has to say when: N of these in a row, each awaiting its own
 * refetch, is a dialog that spends most of a batch re-reading a list nobody has looked at yet.
 */
export function invalidatePlugins(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: pluginKeys.all });
}

/**
 * Grant one plugin to one Bot, and refetch nothing.
 *
 * The write on its own, for the caller granting a batch of them: the server still records a row per
 * grant, so the audit trail is unchanged, but the reader is refreshed once at the end rather than
 * between every pair. Anything granting a single one should use the mutation below instead, which
 * carries the refetch with it.
 */
export function grantPlugin(variables: {
  kind: PluginKind;
  ref: string;
  agentId: string;
}): Promise<unknown> {
  return client("/api/plugins/grants", {
    method: "POST",
    body: {
      kind: variables.kind,
      ref: variables.ref,
      agentId: variables.agentId,
    },
    fallback: "That Agent could not be changed.",
  });
}

/**
 * Grant a reviewed set in one HTTP request.
 *
 * GitHub alone advertises hundreds of tools. Sending one browser request per tool makes a category
 * grant take minutes and leaves it dependent on the tab staying open. The server still writes and
 * audits each individual grant; this only makes the network operation a batch.
 */
export function grantPlugins(variables: {
  refs: string[];
  agentIds: string[];
}): Promise<unknown> {
  return client("/api/plugins/grants/bulk", {
    method: "POST",
    body: {
      kind: "mcp",
      refs: variables.refs,
      agentIds: variables.agentIds,
    },
    fallback: "Those tools could not be granted.",
  });
}

/**
 * Replace one Bot's exact grants for a connector with a capability-sized bundle.
 *
 * The server expands the level from its current tool catalogue and writes the exact refs in one
 * transaction. A remote catalogue can change, so the browser never tries to be the authority on
 * which names belong in a read, write or destructive set.
 */
export function setAgentConnectorCapabilityMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: setAgentConnectorCapability,
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function setAgentConnectorCapability(variables: {
  agentId: string;
  serverId: string;
  level: ConnectorCapabilityLevel;
}): Promise<unknown> {
  return client("/api/plugins/grants/capability", {
    method: "PUT",
    body: variables,
    fallback: "That connector capability could not be saved.",
  });
}

/**
 * Whether one Bot carries one plugin.
 *
 * Granting posts to the collection; withholding deletes from it, and the delete identifies the row
 * by query string because a grant has no id of its own — it is the three things it joins.
 */
export function setPluginGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      kind: PluginKind;
      ref: string;
      agentId: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await grantPlugin(variables);
        return;
      }
      await client(
        `/api/plugins/grants?kind=${variables.kind}&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: "That Agent could not be changed." },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function addCuratedServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CuratedServerInput) => {
      await client("/api/plugins/servers", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function addCustomServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: CustomServerInput) => {
      await client("/api/plugins/servers/custom", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/** Re-read a server's tool list, which is what makes a newly-added tool appear. */
export function refreshPluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${serverId}/refresh`, {
        method: "POST",
        body: {},
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function removePluginServerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (serverId: string) => {
      await client(`/api/plugins/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Write a skill, or rewrite one.
 *
 * One endpoint for both: the slug is the identity, so posting an existing one replaces it. The
 * fallback names saving rather than creating for that reason.
 */
export function saveSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: SkillInput): Promise<unknown> =>
      client("/api/plugins/skills", {
        method: "POST",
        body: input,
        /*
         * The server refuses for reasons a form cannot check — a slug somebody else already owns is
         * the common one — and paraphrasing that would throw away the only part worth reading.
         */
        fallback: "The skill could not be saved.",
      }),
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/** The deployment's OAuth client for a vendor reached as the person asking. */
export type OAuthClientInput = {
  serverId: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Register the deployment's OAuth client for a `user-oauth` server.
 *
 * Its own write rather than a field on the curated-server input, because it has its own lifetime: a
 * client is rotated without the server being re-added, and re-adding a server should not mean
 * re-typing a client. It is also recorded against the server row, so it can only happen once that
 * row exists — which is why the page chains it rather than sending both at once.
 *
 * Nobody's documents are reachable with what this sends. A client identifies this deployment to the
 * vendor; the grant that reads anything belongs to each person and is made on their own settings page.
 */
export function registerOAuthClientMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: OAuthClientInput) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(input.serverId)}/oauth-client`,
        {
          method: "POST",
          body: { clientId: input.clientId, clientSecret: input.clientSecret },
          fallback: "That OAuth client could not be registered.",
        },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

/**
 * Begin connecting the signed-in person's own account.
 *
 * Answers with the vendor's consent URL rather than navigating, so the caller decides when to leave
 * the page. There is deliberately nothing here that could complete the consent on somebody's behalf.
 */
/**
 * Start a consent flow, and say which screen it started from.
 *
 * `returnTo` decides where the vendor's callback puts somebody down, because two screens offer this:
 * a person's own connected-accounts page, and the connector's admin page where an administrator
 * verifies the setup they have just finished. Sending an administrator to their personal settings
 * afterwards is the round trip the inline row exists to remove.
 *
 * A name rather than a URL. The server narrows it to a known set before signing it into the state,
 * so this parameter cannot become an open redirect however it is called.
 */
export function connectAccountMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: (serverId: string): Promise<string> =>
      client<string>(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/connect?returnTo=${returnTo}`,
        "authorizationUrl",
        { method: "POST", fallback: "That account could not be connected." },
      ),
  });
}

/** Revoke the signed-in person's managed account connection. */
export function disconnectAccountMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: { serverId: string; connectionId: string }) => {
      await client(
        `/api/plugins/servers/${encodeURIComponent(input.serverId)}/connections/${encodeURIComponent(input.connectionId)}`,
        {
          method: "DELETE",
          fallback: "That account could not be disconnected.",
        },
      );
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}

export function removeSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (slug: string) => {
      await client(`/api/plugins/skills/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidatePlugins(queryClient),
  });
}
