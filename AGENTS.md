# NanoClaw

Personal OpenAI Codex assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram (Bot API), stores messages in SQLite, and routes each message to the OpenAI Codex CLI running inside Apple Container (ephemeral Linux VMs). Single-owner private DM only.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: Telegram connection, owner lock, routing, IPC |
| `src/config.ts` | Paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/main/MEMORY.md` | Long-term memory (single DM) |
| `docs/SOUL.md` | Agent voice + response style (injected into prompt) |
| `docs/DEPLOY_KEYS.md` | Persistent SSH deploy keys (mounted into container) |

## Skills (Codex Playbooks)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
