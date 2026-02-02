# NanoClaw Codex Migration Handoff

Date: 2026-02-02

## Summary (What I Did)
- Replaced the container agent runner to use OpenAI Codex CLI (`codex exec`) with JSON output and IPC actions.
- Added response schema and action handling (schedule tasks, send messages, manage groups).
- Switched session mounts to `data/sessions/{group}/.codex` and env filtering to `CODEX_API_KEY`.
- Migrated project context and memory files to `AGENTS.md` and `MEMORY.md`.
- Updated docs and skills to reflect Codex, IPC actions, and new file paths.
- Removed legacy `.mcp.json` and Claude-specific SDK references.

## Update (Telegram Swap)
- Replaced WhatsApp/Baileys I/O with Telegram Bot API (Telegraf) in `src/index.ts`.
- Added Telegram env config (`TELEGRAM_BOT_TOKEN`, optional allowlists, auto-register first DM).
- Removed WhatsApp auth flow and dependencies; updated docs/skills for Telegram.
- Adjusted DB message storage to use explicit message fields (no Baileys proto).
- Updated group memory formatting notes for Telegram.
- Fixed Codex structured output schema to satisfy strict JSON schema requirements (all action fields required; unused fields null).

## Assumptions
- Codex CLI is installed in the container via `npm install -g @openai/codex`.
- Codex authentication uses `CODEX_API_KEY` (single env var).
- Codex resumes prior sessions with `codex exec resume --last` when a marker exists.
- Web access is via shell tools (curl/wget) + `agent-browser` rather than built-in WebSearch/WebFetch.
- Telegram bot token will be provided in `.env` as `TELEGRAM_BOT_TOKEN`.
- First private DM will auto-register as `main` unless `TELEGRAM_AUTO_REGISTER=false`.

## Remaining / Follow-ups
- Build the container image after pulling (`./container/build.sh`) so Codex CLI and schema are included.
- Ensure `.env` contains `CODEX_API_KEY` and is mounted into the container (done via `src/container-runner.ts`).
- Validate session behavior across messages in real usage (Codex resume behavior may differ).
- Legacy MCP-based skills (`add-gmail`, `add-parallel`) need IPC-action ports if you want those features.
- If you rely on automatic conversation compaction/archiving, Codex doesn’t provide Claude SDK hooks—summaries should be written to `MEMORY.md` manually or via a new action/automation.
- Provide Telegram bot token and send first DM to auto-register the main chat.
