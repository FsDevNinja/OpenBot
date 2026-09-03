import type { TriggerConfig, TriggerSuggestion } from "prompt-area/helpers";
import { commandTrigger, mentionTrigger } from "prompt-area/helpers";
import {
  AGENT_TRIGGER,
  COMMAND_TRIGGER,
  type CommandOption,
  mentionValue,
} from "./draft";

/**
 * The composer's trigger registry.
 *
 * Adding a trigger means adding a factory here and passing its source down; composer rendering stays
 * independent of trigger semantics.
 */

export type AgentOption = {
  id: string;
  name: string;
  description?: string;
};

export type ConnectionOption = {
  /** Stable plugin server id, for example `composio-github`. */
  id: string;
  /** Human vendor name shown in the chip, for example `GitHub`. */
  name: string;
  description?: string;
};

/**
 * Narrows the agent roster to mention options, scoped to a channel's permitted agents when
 * `permittedIds` is given.
 *
 * Takes a structural shape so the composer stays independent of the queries module.
 */
export function toAgentOptions(
  profiles: readonly { id: string; name: string; title?: string }[] | undefined,
  permittedIds?: readonly string[],
): AgentOption[] {
  if (!profiles) {
    return [];
  }
  const permitted = permittedIds ? new Set(permittedIds) : null;
  return profiles
    .filter((profile) => !permitted || permitted.has(profile.id))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.title,
    }));
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * `@` selects either the agent that answers or a connected account it should use.
 *
 * `reopenOnChipClick` keeps an inserted mention editable without deleting and retyping.
 */
export function mentionTriggerConfig(
  agents: readonly AgentOption[],
  connections: readonly ConnectionOption[],
): TriggerConfig {
  return mentionTrigger({
    char: AGENT_TRIGGER,
    accessibilityLabel: "agent or connected account",
    reopenOnChipClick: true,
    emptyMessage: "No matching agents or connected accounts",
    onSearch: (query): TriggerSuggestion[] => [
      ...agents
        .filter((agent) => matches(query, agent.name, agent.description))
        .map((agent) => ({
          value: mentionValue("agent", agent.id),
          label: agent.name,
          description: agent.description
            ? `Agent · ${agent.description}`
            : "Agent",
        })),
      ...connections
        .filter((connection) =>
          matches(query, connection.name, connection.description),
        )
        .map((connection) => ({
          value: mentionValue("connection", connection.id),
          label: connection.name,
          description: connection.description
            ? `Connected account · ${connection.description}`
            : "Connected account",
        })),
    ],
    onSelect: (suggestion) => suggestion.label,
  });
}

/**
 * `/` is restricted to the start of a line, so a URL or a date in the middle of a sentence never
 * opens the dropdown. Selection resolves to a chip; `applyCommandChips` then rewrites the ones that
 * are really prompts or client actions.
 */
export function slashCommandTrigger(
  commands: readonly CommandOption[],
): TriggerConfig {
  return commandTrigger({
    char: COMMAND_TRIGGER,
    position: "start",
    accessibilityLabel: "command",
    emptyMessage: "No matching commands",
    onSearch: (query): TriggerSuggestion[] =>
      commands
        .filter((command) => matches(query, command.name, command.description))
        .map((command) => ({
          value: command.id,
          label: command.name,
          description: command.description,
        })),
    onSelect: (suggestion) => suggestion.label,
  });
}

export function buildTriggers({
  agents,
  connections,
  commands,
}: {
  agents: readonly AgentOption[];
  connections: readonly ConnectionOption[];
  commands: readonly CommandOption[];
}): TriggerConfig[] {
  return [
    mentionTriggerConfig(agents, connections),
    slashCommandTrigger(commands),
  ];
}
