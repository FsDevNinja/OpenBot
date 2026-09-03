import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ConnectionOption } from "@/components/channels/composer";
import { connectionsQueryOptions } from "./queries";

/**
 * Connected accounts that may be named in a message.
 *
 * The endpoint is scoped to the signed-in person and returns only connections on enabled workspace
 * connectors. That makes this deliberately different from the admin catalogue: `@GitHub` means
 * this person's GitHub connection, never a shared deployment credential or somebody else's login.
 */
export function useConnectionMentions(): ConnectionOption[] {
  const { data } = useQuery(connectionsQueryOptions());

  return useMemo(
    () =>
      (data?.connections ?? []).map((connection) => ({
        id: connection.serverId,
        name: connection.title,
        description: connection.vendor,
      })),
    [data],
  );
}

/**
 * Turn structured connection mentions into a runtime instruction without changing permissions.
 *
 * The tool prefix is advisory to the model. The server still offers only tools the Bot was granted,
 * and every call still resolves the actor's own credential and passes policy/audit checks.
 */
export function connectionMentionInstructions(
  ids: readonly string[],
  options: readonly ConnectionOption[],
): string[] {
  const byId = new Map(options.map((option) => [option.id, option]));
  const selected = [...new Set(ids)].flatMap((id) => {
    const option = byId.get(id);
    return option ? [{ id, name: option.name }] : [];
  });
  if (selected.length === 0) return [];

  return [
    [
      `The person explicitly selected these connected accounts for this turn: ${selected
        .map(({ name }) => name)
        .join(", ")}.`,
      `Prefer this Bot's already-granted tools with these prefixes: ${selected
        .map(({ id }) => `mcp__${id}__`)
        .join(", ")}.`,
      "This selection does not grant any new tool or permission.",
      "If an appropriate selected-account tool is not available, say that an administrator must grant it to this Bot. Do not substitute a browser login.",
    ].join("\n"),
  ];
}
