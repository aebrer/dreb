# @dreb/telegram

Telegram bot frontend for the dreb coding agent. Communicates with dreb via its native RPC protocol (stdin/stdout JSONL).

## Setup

### 1. Create a Telegram bot

Talk to [@BotFather](https://t.me/BotFather) on Telegram and create a new bot with `/newbot`. Copy the token.

### 2. Get your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) to get your numeric user ID.

### 3. Configure environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot API token from BotFather |
| `ALLOWED_USER_IDS` | ✅ | Comma-separated authorized user IDs |
| `DREB_WORKING_DIR` | | Working directory for sessions (default: `$HOME`) |
| `DREB_PATH` | | Path to dreb binary (default: `dreb`) |
| `DREB_TELEGRAM_SERVICE` | | Systemd service name (default: `dreb-telegram`) |
| `DREB_PROVIDER` | | LLM provider (e.g., `anthropic`) |
| `DREB_MODEL` | | Model ID (e.g., `claude-sonnet-4`) |

### 4. Create secrets file

The bot loads secrets from `~/.dreb/secrets/telegram.env` automatically — both when run directly and via systemd.

```bash
mkdir -p ~/.dreb/secrets
cat > ~/.dreb/secrets/telegram.env << 'EOF'
TELEGRAM_BOT_TOKEN=your-token-here
ALLOWED_USER_IDS=your-user-id-here
EOF
chmod 600 ~/.dreb/secrets/telegram.env
```

This file is gitignored. Explicit environment variables take priority over the file.

### 5. Build and run

```bash
# From the monorepo root
npm run build

# Run directly (auto-loads secrets from ~/.dreb/secrets/telegram.env)
node packages/telegram/dist/index.js
```

### 6. Systemd service (recommended)

```bash
cp packages/telegram/dreb-telegram.service.template ~/.config/systemd/user/dreb-telegram.service
systemctl --user daemon-reload
systemctl --user enable --now dreb-telegram
```

## Commands

### Session
- `/start` — Help & command list
- `/new` — Start fresh session
- `/sessions` — List recent sessions
- `/resume <id>` — Resume by session ID prefix
- `/recent [N]` — Resend last N assistant messages

### Agent
- `/status` — Connection & version info
- `/stats` — Token usage & cost
- `/compact` — Compact context
- `/model [pattern]` — View/switch model
- `/thinking [level]` — View/set thinking level
- `/agents` — Background subagent status

### Control
- `/cwd` — Working directory
- `/stop` — Interrupt & clear queue
- `/restart` — Restart the bot service

## Features

- **Per-user message queue** — one prompt at a time, incoming messages queued
- **Live tool display** — ephemeral status message shows tools, task lists, subagents
- **Rate-limited status updates** — debounced to avoid Telegram 429 errors
- **File upload** — documents, photos, voice, audio, video with 3s batching
- **File download** — `[[telegram:send:/path]]` markers in assistant text
- **Session management** — auto-resume latest, prefix matching, persistence
- **Markdown with fallback** — tries Markdown first, falls back to plain text
- **Process isolation** — one RPC subprocess per user, auto-restart on crash
