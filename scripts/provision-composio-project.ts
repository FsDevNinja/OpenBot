#!/usr/bin/env bun

import { basename, resolve } from "node:path";
import {
  ComposioProvisioningError,
  composioDeploymentId,
  createComposioOrganizationClient,
  createEnvFileSecretSink,
  provisionComposioProject,
} from "./lib/composio-project-provisioner";

type Arguments = {
  workspace?: string;
  environment?: string;
  output?: string;
  help: boolean;
};

const usage = `Provision one isolated Composio project for one OpenBot deployment.

Usage:
  bun run composio:provision -- --workspace <stable-id> --environment <name> --output <.env.* path>

Required environment:
  COMPOSIO_ORG_API_KEY  Inject this only into this command. Do not put it in OpenBot's .env.

The output contains the deployment-scoped COMPOSIO_API_KEY and DEPLOYMENT_ID. It is created with
mode 0600 and never overwritten. The API key is never printed.`;

function parseArguments(values: string[]): Arguments {
  const parsed: Arguments = { help: false };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--help" || flag === "-h") {
      parsed.help = true;
      continue;
    }
    if (
      flag !== "--workspace" &&
      flag !== "--environment" &&
      flag !== "--output"
    ) {
      throw new ComposioProvisioningError(`Unknown argument: ${flag ?? ""}`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ComposioProvisioningError(`${flag} requires a value.`);
    }
    index += 1;
    if (flag === "--workspace") parsed.workspace = value;
    if (flag === "--environment") parsed.environment = value;
    if (flag === "--output") parsed.output = value;
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  if (!args.workspace || !args.environment || !args.output) {
    throw new ComposioProvisioningError(
      `--workspace, --environment and --output are all required.\n\n${usage}`,
    );
  }
  const output = resolve(args.output);
  const outputName = basename(output);
  if (outputName !== ".env" && !outputName.startsWith(".env.")) {
    throw new ComposioProvisioningError(
      "The output must be a gitignored .env or .env.* file.",
    );
  }

  const deploymentId = composioDeploymentId(args.workspace, args.environment);
  const client = createComposioOrganizationClient({
    organizationApiKey: process.env.COMPOSIO_ORG_API_KEY ?? "",
  });
  const result = await provisionComposioProject({
    client,
    deploymentId,
    sink: createEnvFileSecretSink({ path: output, deploymentId }),
  });
  console.log(
    `${result.status === "created" ? "Created" : "Already provisioned"} Composio project ${
      result.project.name
    } (${result.project.id}). Deployment secrets are in ${output}; no API key was printed.`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
