import { expect, test } from "bun:test";
import {
  capabilityDescription,
  connectorCapabilityLevel,
} from "../src/lib/plugins/capabilities";
import type { PluginServer } from "../src/lib/plugins/queries";

const tools: PluginServer["tools"] = [
  {
    serverId: "github",
    name: "get",
    description: "Read",
    inputSchema: {},
    ref: "github/get",
    effect: "write",
    operation: "read",
    grantedTo: [],
  },
  {
    serverId: "github",
    name: "create",
    description: "Write",
    inputSchema: {},
    ref: "github/create",
    effect: "write",
    operation: "write",
    grantedTo: [],
  },
  {
    serverId: "github",
    name: "delete",
    description: "Delete",
    inputSchema: {},
    ref: "github/delete",
    effect: "write",
    operation: "delete",
    grantedTo: [],
  },
];

const server = { tools } as PluginServer;

test("exact grants collapse into understandable connector capability levels", () => {
  expect(connectorCapabilityLevel(server, new Set())).toBe("none");
  expect(connectorCapabilityLevel(server, new Set(["github/get"]))).toBe(
    "read",
  );
  expect(
    connectorCapabilityLevel(server, new Set(["github/get", "github/create"])),
  ).toBe("write");
  expect(
    connectorCapabilityLevel(
      server,
      new Set(["github/get", "github/create", "github/delete"]),
    ),
  ).toBe("delete");
});

test("a legacy partial grant stays visible as custom until it is replaced", () => {
  const held = new Set(["github/create"]);
  expect(connectorCapabilityLevel(server, held)).toBe("custom");
  expect(capabilityDescription(server, "custom", held)).toContain(
    "1 individually granted tool",
  );
});
