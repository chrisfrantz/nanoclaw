# NanoClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers (Apple Container). The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your Mac.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use Telegram and Email, so it supports Telegram and Email. I don't use WhatsApp, so it doesn't support WhatsApp. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Codex CLI guides the setup. I don't need a monitoring dashboard - I ask Codex what's happening. I don't need elaborate logging UIs - I ask Codex to read the logs. I don't need debugging tools - I describe the problem and Codex fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Codex is always there.

### Skills Over Features

When people contribute, they shouldn't add "WhatsApp support alongside Telegram." They should contribute a skill like `/add-whatsapp` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-whatsapp` - Replace Telegram with WhatsApp entirely

### Container Runtime
The project currently uses Apple Container (macOS-only). We need:
- `/convert-to-docker` - Replace Apple Container with standard Docker
- This unlocks Linux support and broader deployment options

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal Codex assistant accessible via Telegram, with minimal custom code.

**Core components:**
- **Codex CLI** as the core agent
- **Apple Container** for isolated agent execution (Linux VMs)
- **Telegram** as the primary I/O channel
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run Codex and can message back
- **Web access** via shell tools and browser automation
- **Browser automation** via agent-browser

**Implementation approach:**
- Use existing tools (Telegram bot, Codex CLI, IPC actions)
- Minimal glue code
- File-based systems where possible (MEMORY.md for memory, `data/` for local state)

---

## Architecture Decisions

### Message Routing
- A router listens to Telegram and routes messages based on configuration
- Only messages from the configured owner account are processed (single private DM)
- Optional trigger prefix: `@Andy` (case insensitive), configurable via `ASSISTANT_NAME` env var

### Memory System
- **Single memory file**: `groups/main/MEMORY.md` is the assistant’s long-term memory
- **Local-only notes**: Persistent, gitignored notes at `data/notes/main/` (mounted at `/workspace/notes`) for running logs and scratchpads
- **Files**: The agent can create/read files under `groups/main/` for durable project artifacts

### Session Management
- Continuity comes from the host sending the **recent chat history** (plus lightweight retrieval hits) into each Codex prompt.
- Codex CLI state is mounted at `data/sessions/main/.codex/` → `/home/node/.codex`, but long-term retention should still be captured in `groups/main/MEMORY.md`.

### Container Isolation
- All agents run inside Apple Container (lightweight Linux VMs)
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation - agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Scheduled Tasks
- Users can ask Codex to schedule recurring or one-time tasks
- Tasks run as full agents in the same main chat context
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages via `send_message`, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)

---

## Integration Points

### Telegram
- Using the Telegram Bot API (Telegraf) for messaging
- Messages stored in SQLite, polled by router
- Token-based bot auth (BotFather)

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Codex JSON actions (inside container) provide scheduling and messaging
- Actions: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Codex CLI in the same containerized main context

### Web Access
- Shell tools (curl/wget) and agent-browser inside the container
- Standard Codex CLI capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Codex CLI
- Users clone the repo and run Codex CLI to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, authenticate Telegram bot, configure scheduler, start services
- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes)

### Deployment
- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: See `docs/SOUL.md`
- **Main channel**: Personal Telegram DM (messaging your bot)

---

## Project Name

**NanoClaw** - A reference to Clawdbot (now OpenClaw).
