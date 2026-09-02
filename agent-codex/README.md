# Codex provider adapter

This host-side AG-UI provider lets OpenBot agents talk to the installed Codex app-server. Codex is
the engine, not an agent profile: people create named roles in OpenBot and select Codex to power
them. Each OpenBot user completes a real ChatGPT device-authorization flow from Settings.

The adapter gives every provider connection an isolated `CODEX_HOME` under
`.openbot-codex/accounts/`; it never reads the host's `~/.codex/auth.json`. Codex owns, persists, and
refreshes the OAuth tokens in that directory. The adapter also records the join between each
connection's OpenBot Intelligence thread and its persistent Codex thread in
`.openbot-codex/threads.json`. On every later run—including after the adapter restarts—it
resumes that Codex thread and refreshes its standing instructions. Codex restores the dynamic-tool
catalog persisted with the thread; OpenBot still rechecks the current grant and policy on every call.

Only tools that OpenBot marks as deployment-owned are exposed as Codex dynamic tools. Calls return
to `/api/agent-tools/call` with OpenBot's signed run assertion and agent token, so the deployment
rechecks the Bot's grant and policy and writes the normal audit events. Codex-native shell, file,
MCP, app, web and multi-agent paths are disabled. The adapter interrupts native shell and file
attempts; turns run in the read-only sandbox without network access, so an action that races the
interrupt cannot write or reach the network.

Enable it with `CODEX_AGENT_ENABLED=true`. `scripts/start.sh` then runs this adapter on
`CODEX_AGENT_PORT` (default `4202`) and skips the two provider-API-key Bot containers. The start
script supplies `AGENT_TOOL_TOKEN`, `OPENBOT_TOOL_URL` and `CODEX_AGENT_STATE`; set those explicitly
when starting `agent-codex` by hand.

The internal authorization endpoints accept the same managed-runtime token as `/ag-ui`. OpenBot
stores only an encrypted opaque connection id after Codex reports OAuth success. Disconnecting
clears that connection's Codex login cache. This allows a shared deployment to serve several users
without sharing one person's ChatGPT authority; a solo user can still create any number of team
members powered by their one personal connection.
