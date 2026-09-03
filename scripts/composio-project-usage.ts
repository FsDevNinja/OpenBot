#!/usr/bin/env bun

import {
  ComposioProvisioningError,
  createComposioOrganizationClient,
} from "./lib/composio-project-provisioner";

type Arguments = {
  projectId?: string;
  from?: string;
  to?: string;
  help: boolean;
};

const usage = `Read Composio usage for one OpenBot customer project.

Usage:
  bun run composio:usage -- --project-id <pr_...> --from <ISO-8601> --to <ISO-8601>

Required environment:
  COMPOSIO_ORG_API_KEY  Inject this only into this command. Do not put it in OpenBot's .env.

The end timestamp is exclusive. Composio permits a maximum range of 366 days.`;

function parseArguments(values: string[]): Arguments {
  const parsed: Arguments = { help: false };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }
    if (flag !== "--project-id" && flag !== "--from" && flag !== "--to") {
      throw new ComposioProvisioningError(`Unknown argument: ${flag ?? ""}`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ComposioProvisioningError(`${flag} requires a value.`);
    }
    index += 1;
    if (flag === "--project-id") parsed.projectId = value;
    if (flag === "--from") parsed.from = value;
    if (flag === "--to") parsed.to = value;
  }
  return parsed;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ComposioProvisioningError(
      `${field} must be an ISO-8601 timestamp.`,
    );
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  if (!args.projectId || !args.from || !args.to) {
    throw new ComposioProvisioningError(
      `--project-id, --from and --to are all required.\n\n${usage}`,
    );
  }
  const from = timestamp(args.from, "--from");
  const to = timestamp(args.to, "--to");
  const client = createComposioOrganizationClient({
    organizationApiKey: process.env.COMPOSIO_ORG_API_KEY ?? "",
  });
  const entities = await client.usageSummary({
    projectId: args.projectId,
    from,
    to,
  });
  console.log(
    JSON.stringify(
      {
        projectId: args.projectId,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        entities,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
