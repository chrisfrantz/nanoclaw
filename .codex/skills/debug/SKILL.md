---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns Apple Container               │ runs Codex CLI
    │ with volume mounts                   │ with IPC actions
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.codex/ ──> /home/node/.codex/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.codex/` (not `/root/.codex/`) for session resumption to work.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Codex sessions** | `data/sessions/{folder}/.codex/` | Per-group Codex session data |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service, add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Codex CLI process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists with a Codex API key:
```bash
cat .env  # Should show:
# CODEX_API_KEY=sk-...
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Apple Container Bug:** Environment variables passed via `-e` are lost when using `-i` (interactive/piped stdin).

**Workaround:** The system extracts only authentication variables (`CODEX_API_KEY`) from `.env` and mounts them for sourcing inside the container. Other env vars are not exposed.

To verify env vars are reaching the container:
```bash
echo '{}' | container run -i \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "CODEX_API_KEY: ${#CODEX_API_KEY} chars"'
```

### 3. Mount Issues

**Apple Container quirks:**
- Only mounts directories, not individual files
- `-v` syntax does NOT support `:ro` suffix - use `--mount` for readonly:
  ```bash
  # Readonly: use --mount
  --mount "type=bind,source=/path,target=/container/path,readonly"

  # Read-write: use -v
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (CODEX_API_KEY)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global MEMORY.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing WhatsApp messages
│   ├── tasks/            # Scheduled task commands
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: WhatsApp groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Codex CLI process exited with code 1"

If sessions aren't being resumed (no continuity between messages), or Codex exits with code 1 when resuming:

**Root cause:** Codex sessions are stored under `$HOME/.codex/`. Inside the container, `HOME=/home/node`, so it expects `/home/node/.codex/`.

**Check the mount path:**
```bash
# In container-runner.ts, verify mount is to /home/node/.codex/, NOT /root/.codex/
grep -A3 "Codex sessions" src/container-runner.ts
```

**Verify sessions are accessible:**
```bash
container run --rm --entrypoint /bin/bash \
  -v $(pwd)/data/sessions/test/.codex:/home/node/.codex \
  nanoclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.codex 2>&1 | head -5
'
```

**Fix:** Ensure `container-runner.ts` mounts to `/home/node/.codex/`:
```typescript
mounts.push({
  hostPath: codexDir,
  containerPath: '/home/node/.codex',  // NOT /root/.codex
  readonly: false
});
```

### 6. IPC Action Failures

If actions aren't being applied, check `data/ipc/{group}/tasks` and `data/ipc/{group}/messages` for queued files and review host logs for IPC processing errors.

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  container run -i \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Codex CLI directly:
```bash
container run --rm --entrypoint /bin/bash \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "Say hello"
'
```

### Interactive shell in container:
```bash
container run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Codex CLI Invocation Reference

The agent-runner executes Codex roughly like:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  --output-schema /app/response-schema.json \
  --output-last-message /tmp/codex-output.json \
  "<prompt>"
```

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
container builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
container images

# Check what's in the image
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Codex CLI version ==="
  codex --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Codex sessions are stored per-group in `data/sessions/{group}/.codex/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.codex/` (NOT `/root/.codex/`)

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.codex/

# Also clear the session ID from NanoClaw's tracking
echo '{}' > data/sessions.json
```

To verify session resumption is working, check that:
- `data/sessions.json` has `codex-last` markers for active groups
- `data/sessions/{group}/.codex/` contains recent files

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && grep -q "CODEX_API_KEY=sk-" .env && echo "OK" || echo "MISSING - add CODEX_API_KEY to .env"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Apple Container system running?"
container system status &>/dev/null && echo "OK" || echo "NOT RUNNING - NanoClaw should auto-start it; check logs"

echo -e "\n4. Container image exists?"
echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.codex" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount to /home/node/.codex/, not /root/.codex/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"

echo -e "\n8. Session markers present?"
[ -f data/sessions.json ] && cat data/sessions.json | grep -q "codex-last" && echo "OK" || echo "CHECK - no codex-last markers yet"
```
