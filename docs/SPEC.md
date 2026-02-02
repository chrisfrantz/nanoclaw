# NanoClaw Specification

A personal Codex assistant accessible via Telegram, with persistent memory per conversation, scheduled tasks, and email integration.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [IPC Actions](#ipc-actions)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                   (Main Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  Telegram    │────────────────────▶│   SQLite Database  │        │
│  │ (Bot API)    │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ spawns container                             │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                  APPLE CONTAINER (Linux VM)                          │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                               │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (mounted from host)       │   │
│  │  Volume mounts:                                                │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)        │   │
│  │    • data/sessions/{group}/.codex/ → /home/node/.codex/        │   │
│  │    • Additional dirs → /workspace/extra/*                      │   │
│  │                                                                │   │
│  │  Capabilities (all groups):                                    │   │
│  │    • Bash (safe - sandboxed in container!)                     │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • Network access via shell tools (curl/wget)                │   │
│  │    • agent-browser (browser automation)                        │   │
│  │    • IPC actions (schedule tasks, send messages)               │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Telegram Connection | Node.js (Telegraf) | Connect to Telegram Bot API, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| Container Runtime | Apple Container | Isolated Linux VMs for agent execution |
| Agent | Codex CLI | Run Codex with file/system access and IPC actions |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

---

## Folder Structure

```
nanoclaw/
├── AGENTS.md                      # Project context for Codex CLI
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .codex/                        # Codex playbooks (skills)
│   └── skills/
│       ├── setup/
│       │   └── SKILL.md           # /setup skill
│       ├── customize/
│       │   └── SKILL.md           # /customize skill
│       └── debug/
│           └── SKILL.md           # /debug skill (container debugging)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Main application (Telegram + routing)
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── utils.ts                   # Generic utility functions
│   ├── db.ts                      # Database initialization and queries
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   └── container-runner.ts        # Spawns agents in Apple Containers
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'node' user, includes Codex CLI)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts           # Entry point (reads JSON, runs agent)
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── groups/
│   ├── MEMORY.md                  # Global memory (all groups read this)
│   ├── main/                      # Self-chat (main control channel)
│   │   ├── MEMORY.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── MEMORY.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   └── messages.db                # SQLite database (messages, scheduled_tasks, task_run_logs)
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Session markers per group
│   ├── registered_groups.json     # Group JID → folder mapping
│   ├── router_state.json          # Last processed timestamp + last agent timestamps
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│   ├── nanoclaw.log               # Host stdout
│   └── nanoclaw.error.log         # Host stderr
│   # Note: Per-container logs are in groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.nanoclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Container configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10);
export const IPC_POLL_INTERVAL = 1000;

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**Note:** Paths must be absolute for Apple Container volume mounts to work correctly.

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in `data/registered_groups.json`:

```json
{
  "telegram:79057070": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/Users/gavriel/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ],
      "timeout": 600000
    }
  }
}
```

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container.

**Apple Container mount syntax note:** Read-write mounts use `-v host:container`, but readonly mounts require `--mount "type=bind,source=...,target=...,readonly"` (the `:ro` suffix doesn't work).

### Codex Authentication

Configure authentication in a `.env` file in the project root:

```bash
CODEX_API_KEY=sk-...
```

Only the authentication variable (`CODEX_API_KEY`) is extracted from `.env` and mounted into the container at `/workspace/env-dir/env`, then sourced by the entrypoint script. This ensures other environment variables in `.env` are not exposed to the agent. This workaround is needed because Apple Container loses `-e` environment variables when using `-i` (interactive mode with piped stdin).

Telegram configuration also lives in `.env` (host-only, not mounted into containers):

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_AUTO_REGISTER=true
TELEGRAM_ALLOWED_USER_IDS=123456789
TELEGRAM_ALLOWED_USERNAMES=yourusername
```

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/config.ts`. This changes:
- The trigger pattern (messages must start with `@YourName` in non-main groups)

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:
- `{{PROJECT_ROOT}}` - Absolute path to your nanoclaw installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

NanoClaw uses a hierarchical memory system based on MEMORY.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/MEMORY.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/MEMORY.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Agent runner injects memory into the Codex prompt:
     - `../MEMORY.md` (parent directory = global memory)
     - `./MEMORY.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./MEMORY.md`
   - When user says "remember this globally" (main channel only), agent writes to `../MEMORY.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (self-chat) can write to global memory
   - Main can manage registered groups and schedule tasks for any group
   - Main can configure additional directory mounts for any group
   - All groups have Bash access (safe because it runs inside container)

---

## Session Management

Sessions enable conversation continuity - Codex resumes prior context.

### How Sessions Work

1. Each group has a session marker stored in `data/sessions.json`
2. Agent runner uses `codex exec resume --last` when a marker exists
3. Codex resumes the most recent session for that group

**data/sessions.json:**
```json
{
  "main": "codex-last",
  "Family Chat": "codex-last"
}
```

---

## Message Flow

### Incoming Message Flow

```
1. User sends Telegram message
   │
   ▼
2. Telegraf receives message via Telegram Bot API
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered_groups.json? → No: ignore
   └── Does message start with @Assistant? → No: ignore
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. Router invokes Codex CLI:
   ├── cwd: groups/{group-name}/
   ├── prompt: conversation history + current message
   ├── resume: last session if available
   └── output: JSON (reply + actions)
   │
   ▼
8. Codex processes message:
   ├── Reads MEMORY.md content from prompt
   └── Uses shell/tools as needed (files, browser automation)
   │
   ▼
9. Router sends response via Telegram Bot API
   │
   ▼
10. Router updates last agent timestamp and saves session ID
```

### Trigger Word Matching

Main group responds to all messages. Other groups require the trigger pattern (default: `@Andy`):
- `@Andy what's the weather?` → ✅ Triggers Codex
- `@andy help me` → ✅ Triggers (case insensitive)
- `Hey @Andy` → ❌ Ignored (trigger not at start)
- `What's up?` → ❌ Ignored (no trigger)

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction in that chat. Each message is formatted with timestamp and sender name:

```
[Jan 31 2:32 PM] John: hey everyone, should we do pizza tonight?
[Jan 31 2:33 PM] Sarah: sounds good to me
[Jan 31 2:35 PM] John: @Andy what toppings do you recommend?
```

This allows the agent to understand the conversation context even if it wasn't mentioned in every message.

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@Andy what's the weather?` | Talk to Codex |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@Andy add group "Family Chat"` | Register a new group |
| `@Assistant remove group "Name"` | `@Andy remove group "Work Team"` | Unregister a group |
| `@Assistant list groups` | `@Andy list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@Andy remember I prefer dark mode` | Add to global memory |

---

## Scheduled Tasks

NanoClaw has a built-in scheduler that runs tasks as full agents in their group's context.

### How Scheduling Works

1. **Group Context**: Tasks created in a group run with that group's working directory and memory
2. **Full Agent Capabilities**: Scheduled tasks have access to all tools (shell commands, file operations, agent-browser, etc.)
3. **Optional Messaging**: Tasks can send messages to their group using the `send_message` tool, or complete silently
4. **Main Channel Privileges**: The main channel can schedule tasks for any group and view all tasks

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | Local ISO timestamp (no Z) | `2024-12-25T09:00:00` |

### Creating a Task

```
User: @Andy remind me every Monday at 9am to review the weekly metrics

Codex:
{
  "reply": "Done! I'll remind you every Monday at 9am.",
  "actions": [
    {
      "type": "schedule_task",
      "prompt": "Send a reminder to review weekly metrics. Be encouraging!",
      "schedule_type": "cron",
      "schedule_value": "0 9 * * 1",
      "context_mode": "group"
    }
  ]
}
```

### One-Time Tasks

```
User: @Andy at 5pm today, send me a summary of today's emails

Codex:
{
  "reply": "Got it. I'll send you a summary at 5pm.",
  "actions": [
    {
      "type": "schedule_task",
      "prompt": "Search for today's emails, summarize the important ones, and send the summary to the group.",
      "schedule_type": "once",
      "schedule_value": "2024-01-31T17:00:00",
      "context_mode": "isolated"
    }
  ]
}
```

### Managing Tasks

From any group:
- `@Andy list my scheduled tasks` - View tasks for this group
- `@Andy pause task [id]` - Pause a task
- `@Andy resume task [id]` - Resume a paused task
- `@Andy cancel task [id]` - Delete a task

From main channel:
- `@Andy list all tasks` - View tasks from all groups
- `@Andy schedule task for "Family Chat": [prompt]` - Schedule for another group

---

## IPC Actions

Codex returns a structured JSON response with an `actions` array. The host watches the IPC directory and applies the actions.

**Available Actions:**
| Action | Purpose |
|--------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a Telegram message to the chat |
| `register_group` | Register a new Telegram chat (main only) |
| `refresh_groups` | Refresh available groups list (main only) |

---

## Deployment

NanoClaw runs as a single macOS launchd service.

### Startup Sequence

When NanoClaw starts, it:
1. **Ensures Apple Container system is running** - Automatically starts it if needed (survives reboots)
2. Initializes the SQLite database
3. Loads state (registered groups, sessions, router state)
4. Starts the Telegram bot
5. Starts the message polling loop
6. Starts the scheduler loop
7. Starts the IPC watcher for container messages

### Service: com.nanoclaw

**launchd/com.nanoclaw.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

### Managing the Service

```bash
# Install service
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# Start service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Check status
launchctl list | grep nanoclaw

# View logs
tail -f logs/nanoclaw.log
```

---

## Security Considerations

### Container Isolation

All agents run inside Apple Container (lightweight Linux VMs), providing:
- **Filesystem isolation**: Agents can only access mounted directories
- **Safe Bash access**: Commands run inside the container, not on your Mac
- **Network isolation**: Can be configured per-container if needed
- **Process isolation**: Container processes can't affect the host
- **Non-root user**: Container runs as unprivileged `node` user (uid 1000)

### Prompt Injection Risk

Telegram messages could contain malicious instructions attempting to manipulate Codex's behavior.

**Mitigations:**
- Container isolation limits blast radius
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Agents can only access their group's mounted directories
- Main can configure additional directories per group
- Model safety training

**Recommendations:**
- Only register trusted groups
- Review additional directory mounts carefully
- Review scheduled tasks periodically
- Monitor logs for unusual activity

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Codex CLI Auth | data/sessions/{group}/.codex/ | Per-group isolation, mounted to /home/node/.codex/ |
| Telegram Bot Token | .env | Stored on host only |

### File Permissions

The groups/ folder contains personal memory and should be protected:
```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list | grep nanoclaw` |
| "Codex CLI process exited with code 1" | Apple Container failed to start | Check logs; NanoClaw auto-starts container system but may fail |
| "Codex CLI process exited with code 1" | Session mount path wrong | Ensure mount is to `/home/node/.codex/` not `/root/.codex/` |
| Session not continuing | Session ID not saved | Check `data/sessions.json` |
| Session not continuing | Mount path mismatch | Container user is `node` with HOME=/home/node; sessions must be at `/home/node/.codex/` |
| "Unauthorized" | Telegram bot token invalid | Update `TELEGRAM_BOT_TOKEN` and restart |
| "No groups registered" | Haven't added groups | Use `@Andy add group "Name"` in main |

### Log Location

- `logs/nanoclaw.log` - stdout
- `logs/nanoclaw.error.log` - stderr

### Debug Mode

Run manually for verbose output:
```bash
npm run dev
# or
node dist/index.js
```
