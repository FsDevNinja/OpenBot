# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed or custom image, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Thread mapping       | `channel_threads`               | Channel-to-native-thread relation.                                    |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be renamed,
reconfigured, or deleted through the product. An administrator can still set their deployment-local
avatar without changing the profile the package owns.

## Avatars

A person changes their own avatar in **Settings**. A Bot owner changes its avatar in the coworker
dialog, and an administrator can do the same for any Bot, including one supplied by the tenant
package. Removing a custom image returns to the identity-provider image or initials for a person,
and to the generated avatar for a Bot.

Without an upload, a Bot gets a transparent OpenBot shape-and-colour preset. Its owner can choose
among eight shapes and eleven colours or reset to the deterministic default derived from the avatar
seed. The shape itself is the face: its white eyes blink and look around while the silhouette moves
subtly, with no generated background disc. The selected face follows the Bot through profiles,
sidebars, recipients, handoffs, and group-channel avatars. Idle motion is disabled by the person's
reduced-motion preference and is independent from the separate working-status badge.

Uploads accept PNG, JPEG, WebP, and animated GIF images up to 2 MB. The server checks the decoded
size, file signature, and dimensions before storing the image in PostgreSQL. GIF bytes are served
unchanged so their animation remains intact. Roster and channel responses carry a short versioned
image URL rather than the image bytes, so one list never copies every avatar into its JSON response.

## Channels

Starting a channel creates a new native thread. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui
```

That is `agent-langgraph`, which runs a real framework and its own tool loop. The proof-of-concept on
`4200` hand-writes the protocol and leaves the loop to whatever is watching, so it is a reference
rather than something to build a deployment on.

With `CODEX_AGENT_ENABLED=true`, `scripts/start.sh` instead registers
`http://localhost:4202/ag-ui`, starts the Codex adapter on the host, and skips both provider-key Bot
containers. The adapter reuses the existing ChatGPT login, resumes its Codex threads, and sends only
assigned tool calls back through OpenBot's governed callback. See
[the local Codex provider guide](../agent-codex/README.md).

Codex appears as a provider in **New team member**, never as a package agent or default channel.
Choosing it creates a private, owned agent whose name, title, standing role, grants, channels, and
avatar can be changed independently. Repeat that for a Chief of Staff, researcher, analyst, or any
other role; they share the solo provider login but not their profile or conversation state.

The URL is optional. Set it with `MANAGED_AGENT_TOKEN`, or leave it unset: product-created coworkers
then need their own endpoint, and a package agent whose endpoint expands to nothing is omitted
rather than registered against a missing host. A leftover token with no URL is ignored.
Package-provided agents otherwise use their own `agents.yaml` configuration.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create or edit a coworker from `/agents` and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- administrators choose which connector catalogues exist in the workspace and set hard boundaries;
- the coworker owner chooses none, read-only, read-and-write, or full connector access from the
  coworker's **Capabilities** page; OpenBot persists the corresponding exact tool grants internally;
- a connector still runs through the invoking person's own connected account, so a public coworker
  never shares the creator's provider credentials;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

## Handing work to another coworker

Any registered coworker can be granted other coworkers under **Handoff → Bots it may ask**. The
grant is directional and administrator-controlled. Built-in coworkers execute the handoff tool in
the native loop; provider-backed and custom AG-UI coworkers call the same governed tool through the
signed callback gateway. The receiving coworker runs as the same person with its own role and
capabilities, and its answer is relayed into the conversation that asked.

The role itself grants nothing. Calling a coworker still requires an exact handoff grant, current
visibility, and the deployment's depth and per-run fan-out limits.

See [architecture.md](architecture.md).
