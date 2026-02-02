---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate Telegram, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (creating bot tokens, sending a test message).

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoClaw needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** NanoClaw automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure Codex Authentication

Ask the user if they want to use **Codex OAuth** (preferred) or an **API key**.

### Option A: Codex OAuth (recommended)

Verify the user is logged in with Codex CLI and copy the auth file into the main session:

```bash
codex login status || true
mkdir -p data/sessions/main/.codex
cp ~/.codex/auth.json data/sessions/main/.codex/auth.json
chmod 600 data/sessions/main/.codex/auth.json
```

### Option B: API key

Create `.env` and set the key:

```bash
echo 'CODEX_API_KEY=' > .env
```

Then verify:

```bash
KEY=$(grep "^CODEX_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 4. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Codex CLI, and agent-browser.

Verify the build succeeded by running a simple test (this auto-detects which runtime you're using):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 5. Telegram Bot Setup

**USER ACTION REQUIRED**

Ask the user to create a Telegram bot with `@BotFather` and provide the bot token.

Store the token in `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=${TOKEN}" >> .env
```

Validate the token:

```bash
TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" .env | cut -d= -f2)
curl -s "https://api.telegram.org/bot${TOKEN}/getMe"
```

Optional: If the user wants to restrict access, set allowlists:

```bash
echo "TELEGRAM_ALLOWED_USER_IDS=123456789" >> .env
echo "TELEGRAM_ALLOWED_USERNAMES=yourusername" >> .env
```

## 6. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Codex.

If they choose something other than `Andy`, update it in these places:
1. `groups/MEMORY.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/MEMORY.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating the registered_groups.json and when telling them how to test.

## 7. Register Main Channel

For Telegram, the first **private DM** can auto-register as the main channel.

Start the app briefly and ask the user to send a DM to the bot while it's running:

```bash
timeout 15 npm run dev || true
```

If auto-registration is disabled (`TELEGRAM_AUTO_REGISTER=false`), manually register the chat by querying the DB and writing `data/registered_groups.json`:

```bash
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE 'telegram:%' ORDER BY timestamp DESC LIMIT 5"
```

Then update `data/registered_groups.json`:
```json
{
  "telegram:CHAT_ID": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Codex to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 8a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 8b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other Telegram chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 8c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app", "containerPath": "my-app", "readonly": false }
>   ]
> }
> ```

## 9. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 11. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in Telegram.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Codex CLI process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Check that the chat JID is in `data/registered_groups.json`
- Check `logs/nanoclaw.log` for errors

**Telegram bot not responding**:
- Verify `TELEGRAM_BOT_TOKEN` is correct
- Check `logs/nanoclaw.log` for errors
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
