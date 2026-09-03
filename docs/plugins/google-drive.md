# Google Drive

Google Drive is a per-person managed connector. An administrator enables it and decides which Bots
may use its tools; each person separately connects the Google account those Bots should act as.

## Authentication ownership

OpenBot does not create a Google OAuth application and does not store Google access or refresh
tokens. Composio owns the OAuth client, hosted consent flow, token exchange, encrypted token storage,
refresh, and revocation. OpenBot persists only connector policy, tool grants, and audit events. When
it lists the signed-in person's connections, Composio returns an opaque connection id and status —
never a provider credential.

Connections are private by default and keyed with an opaque id derived from both the OpenBot
deployment and user. A Bot tool call sends that id, the reviewed `googledrive` toolkit slug, the tool
name, and its arguments to Composio. It cannot fall back to another person's connection, another
customer deployment, or a deployment-wide Google credential.

## Deployment setup

1. Create a distinct Composio project for this deployment and copy its project API key. For a hosted
   fleet, use the [SaaS provisioning boundary](../composio-saas.md).
2. Set `COMPOSIO_API_KEY` in the OpenBot server environment.
3. Restart the server.
4. Enable Google Drive at `/admin/plugins/google-drive`.
5. Grant only the required tools to the required Bots.

No Google Cloud OAuth client id, client secret, redirect URI, or token callback is configured in
OpenBot. The API key identifies the OpenBot deployment to Composio; it does not grant access to a
person's Drive by itself.

## Personal connection

Open `/settings/connected-accounts/google-drive` and choose **Connect**. Composio opens the Google
consent flow and returns to OpenBot when it finishes. Disconnecting from the same screen asks
Composio to delete the private connected account and revoke its usable tokens.

## Governance

Composio's tool catalogue may change independently of an OpenBot release. OpenBot therefore treats
every managed tool as a write until its effect is explicitly reviewed. Agent grants, the action
policy, and audit logging are still enforced locally on every call.

Composio toolkit reference: <https://docs.composio.dev/toolkits/googledrive>
