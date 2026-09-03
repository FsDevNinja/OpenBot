import type { ConnectorCapabilityLevel, PluginServer } from "./queries";

export const CAPABILITY_LABELS = {
  none: "No access",
  read: "Read only",
  write: "Read and write",
  delete: "Full access",
  custom: "Custom",
} as const;

export type DisplayedCapabilityLevel = ConnectorCapabilityLevel | "custom";

/** Infer the connector-sized decision represented by the exact grants the runtime holds. */
export function connectorCapabilityLevel(
  server: PluginServer,
  held: ReadonlySet<string>,
): DisplayedCapabilityLevel {
  const actual = new Set(
    server.tools.filter((tool) => held.has(tool.ref)).map((tool) => tool.ref),
  );
  if (actual.size === 0) return "none";

  const matches = (tools: PluginServer["tools"]) => {
    const expected = new Set(tools.map((tool) => tool.ref));
    return (
      actual.size === expected.size &&
      [...actual].every((ref) => expected.has(ref))
    );
  };
  if (matches(server.tools.filter((tool) => tool.operation === "read"))) {
    return "read";
  }
  if (matches(server.tools.filter((tool) => tool.operation !== "delete"))) {
    return "write";
  }
  if (matches(server.tools)) return "delete";
  return "custom";
}

export function capabilityDescription(
  server: PluginServer,
  level: DisplayedCapabilityLevel,
  held: ReadonlySet<string> = new Set(),
): string {
  const reads = server.tools.filter((tool) => tool.operation === "read").length;
  const writes = server.tools.filter(
    (tool) => tool.operation === "write",
  ).length;
  const deletes = server.tools.filter(
    (tool) => tool.operation === "delete",
  ).length;
  if (level === "none") return "This coworker cannot use this connector.";
  if (level === "read") return `${reads} read-only tools.`;
  if (level === "write") {
    return `${reads} read-only and ${writes} write tools. Destructive tools stay off.`;
  }
  if (level === "delete") {
    return `All ${server.tools.length} tools, including ${deletes} destructive tools.`;
  }
  const count = server.tools.filter((tool) => held.has(tool.ref)).length;
  return `${count} individually granted tools. Choose a level to replace this legacy selection.`;
}
