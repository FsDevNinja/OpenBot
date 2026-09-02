import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  PROVIDER_CONNECTION_HEADER,
  PROVIDER_CREDENTIAL_HEADER,
  PROVIDER_TYPE_HEADER,
} from "../../../shared/agent-authorisation";
import {
  type RegisteredAgent,
  registeredAgentFromRow,
} from "../agents/runtime-registry";
import type { CredentialSecretReader } from "../credentials";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
} from "../db/schema";
import { agentAuthHeaders, authFromConfiguration } from "./auth-header";
import type { AgentActor } from "./profile-types";
import type { ProviderConnectionReader } from "./provider-connections";
import { AGENT_PROVIDER_CATALOG, type AgentProviderRuntime } from "./providers";

/**
 * Read the agents one person may run, on every request.
 *
 * The filtering is in the query, not in JavaScript afterwards: a private coworker must never be
 * read into the process for an actor who cannot see it, and "we fetched it but did not show it" is
 * the shape most accidental disclosures take.
 */
export function createRuntimeAgentLoader(
  database: Database,
  /** Resolves a customer agent's key at load time. Absent means no agent can carry one. */
  vault?: { reader: CredentialSecretReader; encryptionKey: string },
  /** Secret for the deployment-managed Bot. Never sent to customer-owned endpoints. */
  managedAgents?:
    | { endpoint: URL; token: string }
    | readonly AgentProviderRuntime[],
  /** Resolves the signed-in runner's provider account, never the profile owner's. */
  providerConnections?: Pick<ProviderConnectionReader, "credentialFor">,
) {
  const providerRuntimes: readonly AgentProviderRuntime[] = Array.isArray(
    managedAgents,
  )
    ? managedAgents
    : managedAgents
      ? [{ ...AGENT_PROVIDER_CATALOG[1], ...managedAgents }]
      : [];
  return async (actor: AgentActor): Promise<RegisteredAgent[]> => {
    const [active, tombstones] = await Promise.all([
      selectActiveAgents(database, actor),
      selectTombstoneAgents(database, actor),
    ]);

    // A row whose configuration cannot be understood is skipped rather than mounted as a broken
    // agent. Tombstones are appended after, and never overwrite a live agent of the same id.
    const registered = new Map<string, RegisteredAgent>();
    for (const row of active) {
      const agent = registeredAgentFromRow(row);
      if (!agent) continue;
      // The key is resolved per load, rather than being cached on the row: revoking a
      // credential then takes effect on the next run rather than on the next restart.
      if (agent.type === "remote_ag_ui" && vault) {
        const headers = await agentAuthHeaders({
          reader: vault.reader,
          encryptionKey: vault.encryptionKey,
          auth: authFromConfiguration(row.configuration),
        });
        if (headers) agent.headers = headers;
      }
      const providerId = providerIdFrom(row.configuration);
      const provider =
        agent.type === "remote_ag_ui"
          ? providerRuntimes.find(
              (runtime) =>
                runtime.id === providerId ||
                runtime.endpoint.toString() === agent.endpoint,
            )
          : undefined;
      if (agent.type === "remote_ag_ui" && provider) {
        if (providerConnections) {
          const credential = await providerConnections.credentialFor(
            actor,
            provider.id,
          );
          if (!credential) {
            registered.set(agent.id, {
              id: agent.id,
              name: agent.name,
              type: "unavailable",
              reason: `Connect ${provider.name} in Settings before running ${agent.name}.`,
            });
            continue;
          }
          agent.headers = {
            ...agent.headers,
            [PROVIDER_TYPE_HEADER]: provider.id,
            ...(credential.authentication === "api-key"
              ? { [PROVIDER_CREDENTIAL_HEADER]: credential.secret }
              : {
                  [PROVIDER_CONNECTION_HEADER]: credential.connectionId,
                }),
          };
        }
        agent.headers = {
          ...agent.headers,
          "x-openbot-agent-token": provider.token,
        };
      }
      registered.set(agent.id, agent);
    }
    for (const row of tombstones) {
      if (registered.has(row.id)) continue;
      registered.set(row.id, {
        id: row.id,
        name: row.name,
        type: "unavailable",
        reason: `${row.name} has been deleted and can no longer run. Its conversations remain readable.`,
      });
    }

    return [...registered.values()];
  };
}

function providerIdFrom(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const value = (configuration as { providerId?: unknown }).providerId;
  return typeof value === "string" ? value : null;
}

function selectActiveAgents(database: Database, actor: AgentActor) {
  return database
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      configuration: agents.configuration,
      title: agentProfiles.title,
      roleDescription: agentProfiles.roleDescription,
    })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        isNull(agentProfiles.deletedAt),
        actor.role === "admin"
          ? undefined
          : or(
              eq(agentProfiles.visibility, "public"),
              eq(agentProfiles.ownerUserId, actor.id),
            ),
      ),
    );
}

/**
 * Deleted coworkers the caller still has history with.
 *
 * Resolvable so the native runtime can restore the thread the person is reading. Membership of a channel
 * the agent worked in is what authorizes this, not the profile's visibility, which is why deleting
 * a coworker leaves its conversations readable instead of erasing them.
 */
function selectTombstoneAgents(database: Database, actor: AgentActor) {
  return database
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .innerJoin(channelAgents, eq(channelAgents.agentId, agents.id))
    .innerJoin(
      channelMemberships,
      and(
        eq(channelMemberships.channelId, channelAgents.channelId),
        eq(channelMemberships.userId, actor.id),
      ),
    )
    .where(isNotNull(agentProfiles.deletedAt));
}
