# Composio in a hosted OpenBot

The tenancy boundary is one OpenBot deployment and one Composio project per customer workspace and
environment. A production and staging deployment for the same customer are two projects. They do not
share project keys, connected accounts, auth configs, or webhooks, and their usage is attributable
separately. They still belong to one Composio organization, so the vendor plan, quota, and invoice
remain organization-wide unless your Composio contract says otherwise.

This matches the application that exists today: one OpenBot process loads one tenant package, uses
one `DEPLOYMENT_ID`, and connects to one database. It does not pretend that several customer
workspaces share a process safely when the product has no workspace membership boundary yet.

## Two credentials with different jobs

- `COMPOSIO_ORG_API_KEY` belongs only in a control-plane provisioning or metering worker, or an
  operator shell. It can create and inspect projects across the organization. The OpenBot server
  does not read it.
- `COMPOSIO_API_KEY` is the project key for exactly one deployment. The server uses it for hosted
  consent, connected accounts, tool discovery, and execution inside that project.

Do not store the organization key in an OpenBot `.env`, Kubernetes Secret mounted into the runtime,
tenant package, database, or customer-facing control plane request. A hosted control plane should
fetch it just-in-time from its own secret manager and discard it after provisioning.

## Provision a deployment

The organization credential must already be present in the command's environment, ideally injected
by a secret manager. The command deliberately disables Bun's automatic `.env` loading.

```sh
bun run composio:provision -- \
  --workspace ws_01h_customer_internal_id \
  --environment production \
  --output .env.composio
```

The command derives one deterministic deployment/project name, lists every Composio project before
creating anything, and creates the project with an API key only when it is absent. The output is a
new mode-0600, gitignored env fragment containing:

```dotenv
DEPLOYMENT_ID=openbot-ws-01h-customer-internal-id-production-...
COMPOSIO_PROJECT_ID=pr_...
COMPOSIO_PROJECT_NAME=openbot-ws-01h-customer-internal-id-production-...
COMPOSIO_API_KEY=ak_...
```

The command never prints the API key and never overwrites the file. If the remote project exists but
the full local key is gone, it stops. It does not rotate the project automatically because that would
invalidate a running deployment. Create or rotate a key deliberately in Composio, then install it
through the deployment's secret manager.

For a real SaaS control plane, call the provisioner module with a secret-manager implementation of
`ComposioProjectSecretSink` instead of the env-file sink. The created project key should move from
the create response directly into that customer's deployment secret and nowhere else.

## Run it

For the one-container shape, inject the four generated values alongside the deployment's ordinary
environment. Only `DEPLOYMENT_ID` and `COMPOSIO_API_KEY` are read by the runtime; the project id and
name are operational metadata for reconciliation.

The server refuses to start with `COMPOSIO_API_KEY` but no explicit `DEPLOYMENT_ID`, and rejects a
connector key that does not have the project-key `ak_` prefix. These are configuration failures, not
states that fall back to the tenant package or a shared credential.

For Helm, set the stable id and supply the project key from a secret:

```yaml
config:
  deploymentId: openbot-ws-01h-customer-internal-id-production-...
secrets:
  existingSecret: openbot-customer-secrets
```

The referenced Secret uses the key `composio-project-api-key`. External Secrets uses the same key.
Never add the organization key to either Secret.

Inside the project, OpenBot hashes both the deployment namespace and its user id before sending a
Composio user id. The same person therefore cannot fall through to a connected account in another
customer deployment, even if both OpenBot databases happened to issue the same user id.

## Choose workspace integrations

`/admin/plugins` reads the current toolkit catalogue from that deployment's Composio project. It
offers only remote toolkits with a Composio-managed authentication scheme, so choosing an
integration never turns OAuth application provisioning back into an OpenBot administrator task.
Names, descriptions, logos, categories, and tool counts come from the live response.

Enabling is workspace policy, not user authorization. The server checks the selected key against a
fresh catalogue response, stores the workspace connector, and discovers its tools. Each signed-in
person then connects their own account under `/settings/connected-accounts`; each Bot separately
receives the tools an administrator grants.

If the provider catalogue cannot be read, the admin page shows that failure and offers no invented
list. OpenBot still displays already-enabled connectors from its own database so an outage cannot
hide workspace configuration.

## Metering and offboarding

Composio exposes project usage summary and breakdown endpoints. A billing worker with organization
authority can group usage by project and map `COMPOSIO_PROJECT_ID` back to the OpenBot workspace; the
customer runtime does not need organization authority for that job.

The included command makes that project filter explicit and prints only usage totals:

```sh
bun run composio:usage -- \
  --project-id pr_... \
  --from 2026-08-01T00:00:00Z \
  --to 2026-09-01T00:00:00Z
```

Like provisioning, it disables automatic `.env` loading and expects the organization key to be
injected only into this process. The end timestamp is exclusive, which makes adjacent billing
windows meet without overlapping.

Offboarding is also a control-plane operation: stop the OpenBot deployment, retain or delete its
database according to policy, then deliberately delete its Composio project. Project deletion must
not happen from a runtime shutdown hook—a restart is not customer deletion.

Composio documents projects as its multi-tenancy primitive and its organization API here:
<https://docs.composio.dev/reference/api-reference/projects>.
