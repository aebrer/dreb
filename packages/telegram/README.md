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

### 4. Build and run

```bash
# From the monorepo root
npm run build

# Run directly
TELEGRAM_BOT_TOKEN=... ALLOWED_USER_IDS=... node packages/telegram/dist/index.js
```

### 5. Systemd service (recommended)

Copy the template and fill in your values:

```bash
cp packages/telegram/dreb-telegram.service.template ~/.config/systemd/user/dreb-telegram.service
# Edit the file: replace YOUR_TOKEN_HERE and YOUR_USER_ID_HERE

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
