# Notion

Notion is a per-person managed connector. An administrator enables it and decides which Bots may use
its tools; each person separately connects the Notion workspace those Bots should act as.

## Authentication ownership

OpenBot does not dynamically register a Notion OAuth client and does not store Notion access or
refresh tokens. Composio owns the OAuth application, hosted consent flow, token exchange, encrypted
token storage, refresh, and revocation. OpenBot persists connector policy, tool grants, and audit
events; it receives only opaque connection metadata when it asks Composio for the signed-in
person's connections.

Connections are private and keyed by an opaque id derived from both the OpenBot deployment and user.
A Bot call cannot fall back to an administrator's connection, another person's connection, another
customer deployment, or a deployment-wide Notion token.

## Deployment setup

1. Create a distinct Composio project for this deployment and copy its project API key. For a hosted
   fleet, use the [SaaS provisioning boundary](../composio-saas.md).
2. Set `COMPOSIO_API_KEY` in the OpenBot server environment.
3. Restart the server.
4. Enable Notion at `/admin/plugins/notion`.
5. Grant only the required tools to the required Bots.

There is no Notion integration registration, client secret, dynamic-client state, or OAuth callback
to configure in OpenBot.

## Personal connection

Open `/settings/connected-accounts/notion` and choose **Connect**. Composio runs the Notion consent
flow and returns to OpenBot when it finishes. Disconnecting from the same screen deletes the private
connected account through Composio.

## Governance

OpenBot continues to enforce its agent grants, action policy, and audit trail locally. Because the
managed catalogue can add tools independently of this codebase, every managed tool is conservatively
classified as a write until OpenBot has reviewed richer effect metadata.

Composio toolkit reference: <https://docs.composio.dev/toolkits/notion>
