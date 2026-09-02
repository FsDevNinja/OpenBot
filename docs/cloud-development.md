# Cloud development

Cloud development providers are workers a coworker can delegate repository implementation to. They
do not power the coworker's conversation and they are not coworkers themselves. Model providers
such as Codex, OpenAI, Anthropic, xAI, and Google answer the conversation; a cloud development
provider receives a bounded coding task from that conversation and works in its own cloud workspace.

Cursor is the first supported worker.

## Connect Cursor

1. Open **Settings → Cloud agents**.
2. Create a Cloud Agents API key in Cursor.
3. Paste it into the Cursor connection dialog and choose **Connect**.

OpenBot verifies the key with Cursor before saving it. The credential is encrypted in the existing
credential vault, keyed to the signed-in user, never returned by the API, and never included in a
Bot's prompt or tool result. Alice's coworkers use Alice's Cursor connection; Bob's use Bob's. A
public coworker does not inherit its creator's credential.

Cursor currently authenticates this API with an API key, not an OAuth authorization flow. Removing
the connection revokes the stored key. It does not cancel work already running in Cursor.

## What coworkers can do

When the signed-in user has connected Cursor, every coworker can receive five per-run tools:

- `list_development_models` reads the models and supported parameter values currently available to
  that user's Cursor account;
- `delegate_development_task` starts a new Cursor Cloud Agent for a GitHub repository, an optional
  starting ref, an optional explicit model selection, and a complete implementation brief;
- `update_development_task` sends a follow-up instruction to the same durable Cursor agent and
  workspace after its current run is terminal;
- `cancel_development_task` cancels the active Cursor run;
- `get_development_task` refreshes its status, result, branch, and pull request.

Built-in coworkers execute those tools directly through OpenBot. Remote AG-UI coworkers receive the
same descriptions and call them back through OpenBot using the signed run assertion. Cursor keys
therefore stay on the OpenBot server in both cases.

The tools appear only while that user has a Cursor connection. A coworker should delegate
substantial repository work, not use a cloud worker as a second model for a quick answer.

When a person requests a specific model or option, the coworker first reads the live Cursor model
catalog and then passes the exact model id and supported parameters to the create call. Model
availability is account- and plan-specific, so OpenBot does not keep a global model list. If no
model is requested, OpenBot omits the field and Cursor applies the user's, team's, or system default.
The chosen model is recorded with the durable task and shown on its transcript card.

## Lifecycle and transcript

OpenBot creates a durable task row before it calls Cursor and supplies a deterministic remote agent
id, so a timed-out create can be recovered without silently starting duplicate work. Each follow-up
is a new durable run under the same task. Active tasks are refreshed in the background and whenever
their API or transcript card is read.

The tool result renders as a chat card. While active, it polls for live progress and offers Cancel;
when Cursor reports Git output, it shows the branch and pull-request link. The card always links to
the Cursor run once Cursor has acknowledged it. Database state survives an OpenBot restart, and the
tracker resumes from active rows.

OpenBot sends `workOnCurrentBranch: false` and `autoCreatePR: true`. That asks Cursor to work on a
separate branch and open a pull request. OpenBot itself never merges the branch, deploys it, or grants
the remote worker any credentials beyond the user's Cursor API key.

## API and storage

User-facing routes:

- `GET /api/cloud-agent-providers`
- `PUT /api/cloud-agent-providers/cursor`
- `DELETE /api/cloud-agent-providers/cursor`
- `GET /api/cloud-agent-tasks/:taskId`
- `POST /api/cloud-agent-tasks/:taskId/cancel`

`cloud_agent_tasks` stores task ownership, attribution, repository, selected model, remote identity,
current status, and Git result. `cloud_agent_task_runs` stores the ordered initial and follow-up
runs. Task reads and cancellation always include the signed-in owner in the database lookup;
knowing a task UUID is not enough to read or control another user's work.

Cursor's Cloud Agents API contract is documented in the
[official endpoint reference](https://cursor.com/docs/cloud-agent/api/endpoints).
