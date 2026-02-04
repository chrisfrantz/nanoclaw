# NanoClaw Specification

Single-owner Telegram DM assistant that runs OpenAI Codex CLI inside Apple Container (Linux VM). Designed to run 24/7 via launchd.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session & Context](#session--context)
6. [Message Flow](#message-flow)
7. [Model Commands](#model-commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [IPC Actions](#ipc-actions)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)
12. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                               HOST (macOS)                           │
│                         (single Node.js process)                     │
├──────────────────────────────────────────────────────────────────────┤
│ Telegram Bot API (Telegraf)                                           │
│   └─ stores inbound/outbound messages in SQLite (store/messages.db)    │
│                                                                        │
│ Router loop (polls SQLite) + Scheduler loop + IPC watcher              │
│   └─ builds prompt (recent messages + memory + notes tail + retrieval) │
│   └─ spawns Apple Container per run (ephemeral)                        │
│                                                                        │
├──────────────────────────────────────────────────────────────────────┤
│                       APPLE CONTAINER (Linux VM)                      │
├──────────────────────────────────────────────────────────────────────┤
│ Agent runner (container/agent-runner)                                  │
│   └─ runs Codex CLI non-interactively (codex exec)                     │
│   └─ returns structured JSON (reply + actions)                         │
│   └─ writes IPC action files for the host to apply                     │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Telegram connection | Node.js (Telegraf) | Send/receive messages |
| Message storage | SQLite (better-sqlite3) | Durable chat history + tasks |
| Container runtime | Apple Container | Isolated Linux VM per run |
| Agent engine | OpenAI Codex CLI | Code agent + tools inside container |
| Memory | `groups/main/MEMORY.md` | Long-term memory (durable, editable) |
| Notes | `data/notes/main/` | Local-only running log + scratch |
| IPC | filesystem (`data/ipc/main/`) | Actions from container to host |

---

## Folder Structure

```
nanoclaw/
├── src/                           # host app (TypeScript)
├── dist/                          # host build output (gitignored)
├── container/                     # container image + agent runner
├── launchd/                       # com.nanoclaw.plist template
├── groups/
│   └── main/
│       └── MEMORY.md              # long-term memory for the single DM
├── docs/
│   ├── SOUL.md                    # agent voice + response rules (injected)
│   ├── SPEC.md                    # this doc
│   ├── SECURITY.md                # security model
│   └── DEPLOY_KEYS.md             # persistent SSH deploy keys
├── store/                         # sqlite db (gitignored)
│   └── messages.db
├── data/                          # local-only state (gitignored)
│   ├── router_state.json          # last processed timestamp, etc.
│   ├── model_prefs.json           # per-chat model preference (single chat)
│   ├── notes/main/                # persistent notes (mounted)
│   ├── sessions/main/.codex/      # seeded from ~/.codex (mounted)
│   ├── ssh/main/                  # deploy keys (mounted)
│   └── ipc/main/                  # ipc/messages + ipc/tasks (mounted)
└── logs/                          # host logs (gitignored)
```

---

## Configuration

NanoClaw reads config from `.env` (host only) + environment variables.

### Required

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=123456789
```

Alternative to `TELEGRAM_OWNER_ID`:

```bash
TELEGRAM_ALLOWED_USER_IDS=123456789   # must contain exactly 1 id
```

### Optional

```bash
ASSISTANT_NAME=Andy   # only used for optional @Andy prefix stripping
LOG_LEVEL=info
CONTAINER_IMAGE=nanoclaw-agent:latest
CONTAINER_TIMEOUT=900000
```

### Codex Authentication

NanoClaw is designed for **Codex OAuth**:
- run `codex login` on the host
- NanoClaw seeds `~/.codex/auth.json` and `~/.codex/config.toml` into `data/sessions/main/.codex/`
- that directory is mounted into the container at `/home/node/.codex`

Optional (API key auth):
```bash
CODEX_API_KEY=sk-...
```

Only `CODEX_API_KEY` is ever copied into a mountable env file; the rest of `.env` is not mounted into containers.

---

## Memory System

Three “tiers” of persistence:

1. **Long-term memory (tracked)**: `groups/main/MEMORY.md` (mounted at `/workspace/group/MEMORY.md`)
2. **Local-only notes (gitignored)**: `data/notes/main/` (mounted at `/workspace/notes/`)
   - `journal.md` is auto-appended by the host after each reply (redacted)
3. **Deploy keys (gitignored)**: `data/ssh/main/` (mounted at `/home/node/.ssh`)

The agent runner injects:
- `groups/main/MEMORY.md`
- `docs/SOUL.md`
- the tail of `data/notes/main/journal.md` (redacted)

---

## Session & Context

NanoClaw prioritizes **prompt-based continuity**:
- the host includes the last ~40 messages from SQLite in every prompt
- the host optionally adds lightweight retrieval hits from older history (term search)

This keeps continuity stable even if Codex non-interactive session resume isn’t used.

---

## Message Flow

1. Telegram DM arrives
2. Router enforces:
   - `chat.type === "private"`
   - `from.id === TELEGRAM_OWNER_ID`
3. Message stored in SQLite
4. Poll loop builds a prompt:
   - recent messages (chronological)
   - `<retrieved>` hits (optional)
5. Host spawns a container run:
   - working dir: `/workspace/group`
   - agent runner executes `codex exec` with a strict JSON schema
6. Host sends the `reply` back to Telegram
7. Host appends a redacted journal entry to `data/notes/main/journal.md`

### Trigger prefix

The `@Andy` prefix is optional. If present, it’s stripped. Messages without it are still processed.

---

## Model Commands

In Telegram, send:

- `model help` / `model status`
- `model auto` (default: keyword-based detect)
- `model code` / `model chat` / `model write`
- `model <name> [low|medium|high]` (custom)
  - examples: `model gpt-5.2`, `model gpt-5.2-codex high`

Defaults:
- code → `gpt-5.2-codex` (reasoning high)
- chat → `gpt-5.2`
- write → `gpt-5.2` (reasoning high)

---

## Scheduled Tasks

Tasks are created by the agent via IPC actions (JSON schema output). The host scheduler:
- stores tasks in SQLite (`scheduled_tasks`)
- checks for due tasks every minute
- runs tasks in the same containerized workspace

Schedule types:
- `cron` (cron expression)
- `interval` (milliseconds)
- `once` (local ISO timestamp, no `Z`)

`context_mode`:
- `group` → run with “continuous context” intent
- `isolated` → run with “fresh run” intent

---

## IPC Actions

Available actions in the agent JSON response:

| Action | Purpose |
|--------|---------|
| `send_message` | send a follow-up message to the owner DM |
| `schedule_task` | schedule a task (cron/interval/once) |
| `pause_task` | pause a task by id |
| `resume_task` | resume a task by id |
| `cancel_task` | delete a task by id |

---

## Deployment

NanoClaw is intended to run as a single launchd agent:
- template: `launchd/com.nanoclaw.plist`
- logs: `logs/nanoclaw.log` + `logs/nanoclaw.error.log`

Useful commands:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Security Considerations

- **owner lock**: only a single Telegram user id is accepted.
- **ephemeral containers**: each agent run is a fresh VM (`--rm`).
- **explicit mounts only**: the agent sees only what NanoClaw mounts.
- **deploy keys**: store repo-scoped keys under `data/ssh/main/` (not `~/.ssh`).
- **notes isolation**: local-only state goes to `data/notes/main/` (gitignored).

If you see Telegram error `409 Conflict: terminated by other getUpdates request`, you likely have two NanoClaw instances running.

---

## Troubleshooting

### No replies

- check the service: `launchctl list | rg nanoclaw`
- check logs: `tail -n 200 logs/nanoclaw.error.log`

### Telegram 409 conflict

You have two polling instances running (e.g., launchd + `npm run dev`). Stop one.

### Debug shell (inside the VM)

`./container/shell.sh` opens an interactive shell inside the agent container with the same mounts as the bot.
