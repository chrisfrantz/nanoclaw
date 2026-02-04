# NanoClaw Handoff

Date: 2026-02-04

## Summary (what changed)

- migrated the agent execution path to **openai codex cli** (`codex exec`) with strict json output + ipc actions
- swapped i/o to **telegram bot api** (telegraf) and removed whatsapp assumptions
- simplified routing to **single-owner, single private dm** (no group registration / no “main vs group” concept)
- added durable, local-only persistence:
  - `groups/main/MEMORY.md` (long-term memory)
  - `data/notes/main/` mounted at `/workspace/notes` (journal + scratch)
  - lightweight retrieval from older sqlite history for long-running context
- made ssh deploy keys durable across runs:
  - `data/ssh/main/` mounted at `/home/node/.ssh`
  - docs in `docs/DEPLOY_KEYS.md`
- added a host-side **single instance lock** to prevent telegram `409` conflicts / duplicate processing when two processes are started
- updated docs to match single-dm mode (`README.md`, `docs/SPEC.md`, `docs/SECURITY.md`, `docs/REQUIREMENTS.md`)

## key behavior (current)

- replies to every message in your private dm (optional `@Andy` prefix is stripped)
- owner locked: requires `TELEGRAM_OWNER_ID` (or `TELEGRAM_ALLOWED_USER_IDS` with exactly 1 id)
- model routing:
  - auto detect (code/chat/write) with `model ...` commands to override
  - defaults: code → `gpt-5.2-codex` reasoning high, chat → `gpt-5.2`, write → `gpt-5.2` reasoning high
- container is ephemeral per run; persistence only through mounts (memory/notes/sessions/ssh/ipc)

## assumptions

- apple container is installed + working (`container system status`)
- the agent image exists or can be built: `./container/build.sh` (image: `nanoclaw-agent:latest` by default)
- codex auth is oauth-based (seeded from host `~/.codex/auth.json` into `data/sessions/main/.codex/`)
  - optional: `CODEX_API_KEY` also works, but isn’t required
- telegram token is stored in `.env` (host-only)

## remaining / follow-ups

- if you want the agent to work on other local repos (ex: framekeep), decide whether to:
  - mount the repo into the container via the external mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`), or
  - copy a working checkout into a mounted directory (ex: under `data/notes/main/`)
- debug: `./container/shell.sh` opens an interactive shell inside the agent vm with the same mounts
