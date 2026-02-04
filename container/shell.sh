#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"

GROUP_DIR="$ROOT/groups/main"
NOTES_DIR="$ROOT/data/notes/main"
SESSIONS_DIR="$ROOT/data/sessions/main/.codex"
SSH_DIR="$ROOT/data/ssh/main"
IPC_DIR="$ROOT/data/ipc/main"
ENV_DIR="$ROOT/data/env"

mkdir -p "$GROUP_DIR" "$NOTES_DIR" "$SESSIONS_DIR" "$SSH_DIR" "$IPC_DIR/messages" "$IPC_DIR/tasks"

MOUNTS=(
  -v "$ROOT:/workspace/project"
  -v "$GROUP_DIR:/workspace/group"
  -v "$NOTES_DIR:/workspace/notes"
  -v "$SESSIONS_DIR:/home/node/.codex"
  -v "$SSH_DIR:/home/node/.ssh"
  -v "$IPC_DIR:/workspace/ipc"
)

if [[ -f "$ENV_DIR/env" ]]; then
  MOUNTS+=( --mount "type=bind,source=$ENV_DIR,target=/workspace/env-dir,readonly" )
fi

exec container run -it --rm \
  --entrypoint bash \
  -w /workspace/group \
  "${MOUNTS[@]}" \
  "$IMAGE"

