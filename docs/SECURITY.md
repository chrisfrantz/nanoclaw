# NanoClaw Security Model

NanoClaw is intentionally narrow: **one Telegram owner DM**, one workspace, one host process, and ephemeral container execution.

## Trust Model

| Entity | Trust level | Notes |
|--------|-------------|-------|
| Owner Telegram DM | trusted | only one Telegram user id is accepted |
| Telegram messages | untrusted input | prompt injection is always possible |
| Host process | trusted | runs on your Mac, controls mounts + routing |
| Container agent | sandboxed | runs as non-root `node` inside Apple Container |

## Primary Security Boundaries

### 1) Owner lock (input boundary)

NanoClaw ignores everything except:
- `chat.type === "private"`
- `from.id === TELEGRAM_OWNER_ID` (or a single-id `TELEGRAM_ALLOWED_USER_IDS`)

This prevents other Telegram users (and group chats) from triggering the agent.

### 2) Ephemeral containers (execution boundary)

Each agent run executes in an ephemeral Apple Container VM (`--rm`):
- clean process tree each run
- clean container root filesystem each run
- only mounted directories persist

### 3) Explicit mounts only (data boundary)

The container can only see what NanoClaw mounts. In the default setup, that includes:
- `groups/main/` → `/workspace/group` (rw)
- `data/notes/main/` → `/workspace/notes` (rw, local-only)
- `data/sessions/main/.codex/` → `/home/node/.codex` (rw, Codex auth/session state)
- `data/ssh/main/` → `/home/node/.ssh` (rw, deploy keys)
- `data/ipc/main/` → `/workspace/ipc` (rw, actions)
- project root → `/workspace/project` (rw, to let the agent inspect/patch NanoClaw itself)
- `container/agent-runner/dist/` → `/app/dist` (ro, so the container uses the latest runner build when present)

### 4) Mount allowlist (optional expansion boundary)

If you enable additional mounts, NanoClaw validates them against an external allowlist at:
- `~/.config/nanoclaw/mount-allowlist.json`

That file is never mounted into containers, so the agent can’t weaken the allowlist from inside the sandbox.

## Credentials

What *is* available to the agent (because it must be for work to happen):
- Codex OAuth credentials seeded into `/home/node/.codex` (from the host’s `~/.codex`)
- repo-scoped SSH deploy keys under `/home/node/.ssh`

What is *not* mounted:
- Telegram bot token in `.env` (host-only)
- host `~/.ssh` (use deploy keys under `data/ssh/main/`)

## Data Persistence

Durable + safe-ish for agents:
- `data/notes/main/` for running logs and scratchpads (gitignored)

Durable + tracked (you should review):
- `groups/main/MEMORY.md` (long-term memory)

## Common Footguns

- Telegram `409 Conflict: terminated by other getUpdates request` means **two bot instances** are polling (e.g., launchd + `npm run dev`). Run only one.
- Anything written inside the container outside mounted paths disappears after the run.
