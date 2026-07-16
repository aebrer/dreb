# RPC Mode

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@dreb/coding-agent` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

### Running the agent child as a specific OS user

When using the `RpcClient` from `@dreb/coding-agent/rpc`, `RpcClientOptions` accepts optional `uid` and `gid` fields. When set, they are forwarded directly to `child_process.spawn`, so the agent child (and every subprocess it spawns, including `bash`) runs under that OS user/group. When unset they are omitted entirely, leaving spawn behavior unchanged.

```ts
import { RpcClient } from "@dreb/coding-agent/rpc";

// Parent must hold CAP_SETUID / CAP_SETGID (e.g. run as root) for this to succeed.
const client = new RpcClient({ cwd: "/srv/users/alice", uid: 4001, gid: 4001 });
await client.start();
```

This enables per-user filesystem isolation by plain Unix DAC: give each authenticated user a dedicated UID and a working directory owned by that UID at mode `0700`. If the parent lacks the required capability (or the platform doesn't support `uid`/`gid`, e.g. Windows), the spawn fails and `start()` rejects rather than silently running as the parent user.


## Starting RPC Mode

```bash
dreb --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

### Prompting

#### prompt

Send a user prompt to the agent. Returns immediately; events stream asynchronously.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `dreb.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true}
```

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current agent operation.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "scopedModels": [
      {"provider": "anthropic", "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "reasoning": true, "thinkingLevel": "high"}
    ],
    "usingSubscription": false,
    "tasks": [
      {"id": "inspect", "title": "Inspect the implementation", "status": "in_progress"}
    ],
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

The `model` field is a full [Model](#model) object or `null`. `scopedModels` is the runtime model scope (from settings `enabledModels` / CLI `--models`) in the same order used by model cycling; it is an empty array when no scope is active. `usingSubscription` is true when the active model is using OAuth subscription credentials, matching the TUI footer's `(sub)` cost indicator. The `sessionName` field is the display name set via `set_session_name` or auto-naming, or omitted if not set.

`contextUsage` carries the same numbers the TUI footer shows, computed by the session itself — clients must render these rather than deriving their own estimate. `tokens` and `percent` are `null` when usage is unknown (right after compaction, before the next LLM response). The whole field is omitted when no model is set or the model has no context window.

`tasks` is the current `RpcSessionState` task list. Every task has a stable `id`, `title`, and `pending`, `in_progress`, or `completed` status. It is replaced atomically by each [`tasks_update`](#event-types) event; clients restoring state after a hard refresh or recovery gap should use this snapshot rather than reconstructing tasks from a partial event history.

#### get_dashboard_snapshot

Capture the dashboard-visible parent-session state, full parent transcript, and background-agent registry at one RPC command boundary. This is for authoritative recovery, not ordinary incremental refreshes.

```json
{"id": "snapshot-7", "type": "get_dashboard_snapshot"}
```

The result is a `snapshotId`, a complete `RpcSessionState` (including `tasks`), `messages`, and `backgroundAgents`. The RPC child writes this event to stdout **immediately before** the matching response line:

```json
{"type":"dashboard_snapshot_barrier","snapshotId":"snapshot-7"}
{"id":"snapshot-7","type":"response","command":"get_dashboard_snapshot","success":true,"data":{"snapshotId":"snapshot-7","state":{...},"messages":[...],"backgroundAgents":[...]}}
```

Stdout JSONL ordering is the contract: a relay records its current event-stream sequence when the marker arrives, before resolving the response, and pairs the snapshot only with that exact marker. The dashboard returns that captured sequence as `/api/resync.barrierSeq`; consumers discard queued events through it and replay only later events. The marker itself is not broadcast as another browser event, so one recovering client does not interrupt healthy clients. Do not infer ordering from request/response timing; see [dashboard recovery](dashboard.md#live-connection-and-recovery).

#### get_resources

Get loaded resource metadata for the current session. This returns paths/names/descriptions only — it does not include context file contents, prompt bodies, skill bodies, or system prompt text.

```json
{"type": "get_resources"}
```

Response:
```json
{
  "type": "response",
  "command": "get_resources",
  "success": true,
  "data": {
    "contextFiles": [{"path": "/repo/AGENTS.md"}],
    "skills": [{"name": "review-code", "description": "Review code"}],
    "extensions": [{"name": "my-extension", "path": "/repo/.dreb/extensions/my-extension.ts"}],
    "promptTemplates": [{"name": "plan", "description": "Create an implementation plan"}],
    "systemPromptPresent": true
  }
}
```

#### get_git_branch

Get the current git branch for the session cwd. Returns `null` outside a git repository and `"detached"` for detached HEAD.

```json
{"type": "get_git_branch"}
```

Response:
```json
{
  "type": "response",
  "command": "get_git_branch",
  "success": true,
  "data": {"branch": "feature/dashboard"}
}
```

#### get_daily_cost

Get the same-day aggregate cost across all session files. The RPC process scans once on first call so the first response is current, then returns the cached value (refreshed periodically by the tracker).

```json
{"type": "get_daily_cost"}
```

Response:
```json
{
  "type": "response",
  "command": "get_daily_cost",
  "success": true,
  "data": {"cost": 1.23}
}
```

#### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

### Model

#### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### resolve_model

Resolve a model pattern using the same matching rules as the interactive `/model` command, without switching the current session. Returns `null` if no model matches; a warning may be included when the match required fallback behavior.

```json
{"type": "resolve_model", "pattern": "sonnet"}
```

Response:
```json
{
  "type": "response",
  "command": "resolve_model",
  "success": true,
  "data": {"model": {...}, "warning": "matched provider/model-id"}
}
```

If no model matches:
```json
{"type": "response", "command": "resolve_model", "success": true, "data": null}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Buddy

Buddy commands run inside the agent process so provider credentials never leave the RPC child. They are exposed for clients that choose to render the terminal companion; most non-terminal clients can ignore them.

#### buddy_hatch

Create or load the current buddy state.

```json
{"type": "buddy_hatch"}
```

Response:
```json
{
  "type": "response",
  "command": "buddy_hatch",
  "success": true,
  "data": {"state": {...}}
}
```

#### buddy_reroll

Reroll buddy appearance/state.

```json
{"type": "buddy_reroll"}
```

Response:
```json
{
  "type": "response",
  "command": "buddy_reroll",
  "success": true,
  "data": {"state": {...}}
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`

Note: `"xhigh"` is supported by OpenAI codex-max models and Anthropic Opus 4.6+ (maps to adaptive effort `"max"`).

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

#### get_pending_messages

Return queued steering and follow-up messages without clearing them. `steering` and `followUp` are the text-only compatibility view; `steeringMessages` and `followUpMessages` include inline image attachments for clients that need to restore queued multimodal turns.

```json
{"type": "get_pending_messages"}
```

Response:
```json
{"type": "response", "command": "get_pending_messages", "success": true, "data": {"steering": ["steer text"], "followUp": ["follow-up text"], "steeringMessages": [{"text": "steer text", "images": [{"type": "image", "data": "...", "mimeType": "image/png"}]}], "followUpMessages": [{"text": "follow-up text"}]}}
```

#### clear_pending_messages

Clear queued steering and follow-up messages, returning the cleared payloads. This mirrors the TUI restore-to-editor flow; multimodal clients should use `steeringMessages`/`followUpMessages` so inline images are not lost.

```json
{"type": "clear_pending_messages"}
```

Response:
```json
{"type": "response", "command": "clear_pending_messages", "success": true, "data": {"steering": ["steer text"], "followUp": ["follow-up text"], "steeringMessages": [{"text": "steer text", "images": [{"type": "image", "data": "...", "mimeType": "image/png"}]}], "followUpMessages": [{"text": "follow-up text"}]}}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "details": {}
  }
}
```

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

#### abort_compaction

Abort an in-progress manual or automatic compaction.

```json
{"type": "abort_compaction"}
```

Response:
```json
{"type": "response", "command": "abort_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

### Bash

#### bash

Execute a shell command and add output to conversation context.

```json
{"type": "bash", "command": "ls -la"}
```

Response:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/dreb-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state. This message does NOT emit an event.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

```
Ran `ls -la`
\`\`\`
total 48
drwxr-xr-x ...
\`\`\`
```

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included
3. No event is emitted for the `BashExecutionMessage` itself

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` contains assistant usage totals for the current session state. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### get_performance_stats

Get rolling performance statistics (tokens-per-second) for all models with recorded data.

```json
{"type": "get_performance_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_performance_stats",
  "success": true,
  "data": {
    "models": [
      {
        "provider": "anthropic",
        "modelId": "claude-sonnet-4",
        "median": 31,
        "mean": 32,
        "count": 100
      }
    ]
  }
}
```

`models` contains per-model rolling averages computed from the agent's performance log. Each entry includes the median TPS, mean TPS, and number of recorded turns for that model. Returns an empty `models` array when no performance data has been recorded.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### delete_session

Delete a session file. Deletion tries trash first and falls back to unlink. The currently active session cannot be deleted.

```json
{"type": "delete_session", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "delete_session", "success": true, "data": {"method": "trash"}}
```

If attempting to delete the currently active session:
```json
{
  "type": "response",
  "command": "delete_session",
  "success": false,
  "error": "Cannot delete the currently active session"
}
```

The path uses the same unrestricted, cross-project addressing as [`switch_session`](#switch_session): it is `resolve()`d (collapsing `.`/`..`/relative segments) and then checked against the active session. There is **no** sessions-directory containment guard — this is a trusted local channel, and any frontend exposing it (e.g. the web dashboard) is expected to enforce its own authorization. Deletion is refused only for the currently active session, non-`.jsonl` paths, and nonexistent files:
```json
{
  "type": "response",
  "command": "delete_session",
  "success": false,
  "error": "Not a session file (expected .jsonl): /tmp/evil.txt"
}
```

#### fork

Create a new fork from a previous user message. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. Successful renames also emit a `session_name_changed` event.

### Commands

#### get_commands

Get available commands (extension commands, prompt templates, and skills). These can be invoked via the `prompt` command by prefixing with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "path": "/home/user/.dreb/agent/extensions/session.ts"},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "location": "project", "path": "/home/user/myproject/.dreb/agent/prompts/fix-tests.md"},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "location": "user", "path": "/home/user/.dreb/agent/skills/brave-search/SKILL.md"}
    ]
  }
}
```

Each command has:
- `name`: Command name (invoke with `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `dreb.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `location`: Where it was loaded from (optional, not present for extensions):
  - `"user"`: User-level (`~/.dreb/agent/`)
  - `"project"`: Project-level (`./.dreb/agent/`)
  - `"path"`: Explicit path via CLI or settings
- `path`: Absolute file path to the command source (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

### Session Listing

#### list_sessions

List sessions for the current working directory. Returns sessions sorted by most recently modified first.

```json
{"type": "list_sessions"}
```

Response:
```json
{
  "type": "response",
  "command": "list_sessions",
  "success": true,
  "data": {
    "sessions": [
      {
        "path": "/home/user/.dreb/agent/sessions/--home-user-project--/2024-01-15T10-30-00_abc123.jsonl",
        "id": "abc123-def456-...",
        "cwd": "/home/user/project",
        "name": "feature-work",
        "created": "2024-01-15T10:30:00.000Z",
        "modified": "2024-01-15T11:45:00.000Z",
        "messageCount": 12,
        "firstMessage": "Help me refactor the auth module"
      }
    ]
  }
}
```

Each session has:
- `path`: Full path to the session JSONL file (use with `switch_session`)
- `id`: Session UUID
- `cwd`: Working directory where the session was started
- `name`: User-defined display name (optional)
- `created`: ISO timestamp of session creation
- `modified`: ISO timestamp of last modification
- `messageCount`: Number of messages in the session
- `firstMessage`: First user message text (for preview)

#### list_all_sessions

List sessions across all projects. Returns sessions sorted by most recently modified first. May be slow with many sessions. If the underlying listing fails (an I/O error reading the sessions store), the command responds `success: false` rather than a silently-empty list — so a client can distinguish "no sessions" from "listing failed."

```json
{"type": "list_all_sessions"}
```

Response:
```json
{
  "type": "response",
  "command": "list_all_sessions",
  "success": true,
  "data": {
    "sessions": [
      {
        "path": "/home/user/.dreb/agent/sessions/--home-user-project--/2024-01-15T10-30-00_abc123.jsonl",
        "id": "abc123-def456-...",
        "cwd": "/home/user/project",
        "name": "feature-work",
        "created": "2024-01-15T10:30:00.000Z",
        "modified": "2024-01-15T11:45:00.000Z",
        "messageCount": 12,
        "firstMessage": "Help me refactor the auth module"
      }
    ]
  }
}
```

Each session has the same fields as `list_sessions`.

### Background Agents

#### list_background_agents

List background subagents tracked by this process's registry — running and recently completed (finished entries are pruned after ~5 minutes). `sessionDir` is known from launch; `sessionFile` appears once the child process exits. Live transcripts are delivered via `background_agent_event` events (see Events), not by reading these paths.

```json
{"type": "list_background_agents"}
```

Response:
```json
{
  "type": "response",
  "command": "list_background_agents",
  "success": true,
  "data": {
    "agents": [
      {
        "agentId": "a1b2c3d4e5f6",
        "agentType": "Explore",
        "taskSummary": "Explore task 1/2",
        "startedAt": "2026-07-07T12:00:00.000Z",
        "status": "running",
        "sessionDir": "/home/user/.dreb/agent/subagent-sessions/a1b2c3d4e5f6",
        "cwd": "/home/user/project"
      }
    ]
  }
}
```

#### list_agent_types

List discoverable subagent types for the current session working directory. This includes package-bundled agents, user-level agents, and project-level agents in `.dreb/agents/*.md`. Results are sorted by `name`.

```json
{"type": "list_agent_types"}
```

Response:
```json
{
  "type": "response",
  "command": "list_agent_types",
  "success": true,
  "data": {
    "agentTypes": [
      {
        "name": "code-reviewer",
        "description": "Reviews code changes for correctness, idiomatic patterns, and maintainability"
      },
      {
        "name": "Explore",
        "description": "Codebase and web exploration — find files, search code, search the web, answer questions. Read-only."
      }
    ]
  }
}
```

Each agent type has:
- `name`: Agent type name to use as an `agentModels` key.
- `description`: Human-readable description from the agent frontmatter.

### Session Tree

Sessions are append-only trees: editing/retrying a message or navigating back creates a branch rather than discarding entries. These commands expose tree inspection and navigation — the scriptable equivalent of the TUI's `/tree` selector.

#### get_tree

Get the session tree as a serializable DTO, plus the current leaf position.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "roots": [
      {
        "id": "a1b2c3d4",
        "parentId": null,
        "type": "message",
        "role": "user",
        "preview": "Help me refactor the auth module",
        "timestamp": "2024-01-15T10:30:00.000Z",
        "label": "start",
        "children": [
          {
            "id": "e5f6a7b8",
            "parentId": "a1b2c3d4",
            "type": "message",
            "role": "assistant",
            "preview": "Sure — let's look at the middleware first.",
            "timestamp": "2024-01-15T10:30:05.000Z",
            "children": []
          }
        ]
      }
    ],
    "leafId": "e5f6a7b8"
  }
}
```

Each node has:
- `id`: Entry id (use with `navigate_tree`, `fork`)
- `parentId`: Parent entry id, or `null` for a root. Orphaned roots keep their original non-null `parentId` (referencing an entry not in the tree) — prefer `children` for hierarchy
- `type`: Entry type (`message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `label`, `session_info`)
- `role`: Message role, present only for `type: "message"` entries (`user`, `assistant`, `toolResult`, `bashExecution`)
- `preview`: Short single-line content preview (whitespace-collapsed, max 200 chars). Non-text entries use bracketed forms like `[compaction: 50k tokens]`, `[branch summary]: ...`, `[model: claude-sonnet-4]`, `[bash]: npm test`
- `timestamp`: ISO timestamp of the entry
- `label`: Resolved user label, if any
- `children`: Child nodes, oldest first

`leafId` is the id of the current leaf entry (`null` for an empty session) — the "you are here" marker for a tree UI. The DTO is stable and deliberately does **not** include full message payloads; use `get_messages` for content after navigation.

A well-formed session has exactly one root; orphaned entries (broken parent chains) also surface as roots.

#### navigate_tree

Navigate the current session to a different tree node, optionally summarizing the abandoned branch. Unlike `fork` (which creates a new session file), navigation stays within the same session file.

```json
{"type": "navigate_tree", "targetId": "a1b2c3d4"}
```

With branch summarization:
```json
{
  "type": "navigate_tree",
  "targetId": "a1b2c3d4",
  "summarize": true,
  "customInstructions": "Focus on decisions made",
  "replaceInstructions": false,
  "label": "before-refactor"
}
```

Options (all optional, passed through verbatim to the core navigation — the TUI's interactive summarize prompt is not replicated):
- `summarize`: Generate an LLM summary of the branch being abandoned and attach it at the navigation target. Requires a model and API key.
- `customInstructions`: Extra instructions for the summarizer.
- `replaceInstructions`: If `true`, `customInstructions` replaces the default summarizer prompt instead of augmenting it.
- `label`: Label to attach to the branch summary entry (or to the target entry when not summarizing).

Response:
```json
{
  "type": "response",
  "command": "navigate_tree",
  "success": true,
  "data": {"cancelled": false, "editorText": "Help me refactor the auth module"}
}
```

- `cancelled`: `true` if an extension (`session_before_tree`) cancelled the navigation or summarization was aborted.
- `editorText`: Present when navigating to a `user` (or `custom_message`) entry — the text of that message. The leaf moves to the entry's *parent* so the message can be re-edited and resubmitted; a client should pre-fill its input with this text (this is what the TUI does). Navigating to any other entry type moves the leaf to the entry itself and returns no `editorText`.

After a successful `navigate_tree`, `get_state` and `get_messages` reflect the post-navigation session state.

Errors are explicit `success: false` responses:
```json
{
  "type": "response",
  "command": "navigate_tree",
  "success": false,
  "error": "Entry zzz not found"
}
```

- Unknown `targetId`: `Entry <id> not found`
- Agent currently streaming: `Cannot navigate the session tree while the agent is streaming. Abort or wait for idle first.`
- Branch summarization or compaction in progress: `Cannot navigate the session tree while summarization or compaction is in progress. Wait for idle first.`
- `summarize: true` with no model available: `No model available for summarization`

Note: with `summarize: true` the command is LLM-bound and can take a while. `RpcClient.navigateTree` uses a 5-minute client timeout (overridable via its client-side `timeoutMs` option, which is not sent over the wire); raw-protocol clients should budget accordingly. There is no scriptable abort for an in-flight branch summarization over RPC. A client-side timeout does not stop the server: a timed-out `navigate_tree` may still complete server-side and move the leaf — after a timeout, resync with `get_tree`/`get_state` instead of assuming the navigation failed.

### Settings

Persistent settings, backed by the settings file (see [settings.md](settings.md)). They are normally distinct from live session state, with one security-policy exception:

- **Persistent defaults** (`get_settings` / `set_settings`): provider/model, thinking level, queue modes, compaction/retry/image/skill/thinking-display/transport toggles, and per-agent model fallback lists seed fresh runtimes. Writing these ordinary defaults does **not** change a running session.
- **Global nested-context trust policy** (`autoLoadNestedContext`, `trustedContextFolders`, `effectiveTrustedContextRoots`, and the trust commands below): this is read from `~/.dreb/agent/settings.json` only, never project settings. Active main/subagent processes observe it for **future lazy nested/out-of-cwd loads**; it cannot remove content already injected into a conversation. It does not govern the separate initial upward context scan from the launch cwd.
- **Runtime state** (`get_state` / `set_model` / `set_thinking_level` / `set_steering_mode` / `set_follow_up_mode` / `set_auto_compaction` / `set_auto_retry`): the state of the live session. Note that the runtime setters also persist their values as new defaults as a side effect.

A dashboard settings tab typically reads `get_state` for what is active now and `get_settings` for persistent defaults plus the current global context-trust policy.

#### get_settings

Get persistent settings. Before replying, RPC flushes pending settings writes, reloads durable global and project settings, and then reads the merged view; reopening dashboard Settings therefore sees external file edits. A pending write failure, unreadable file, parse error, or reload failure returns an explicit RPC error rather than a stale snapshot. Ordinary fields are the merged global + project view; the nested-context trust fields are always global-only.

```json
{"type": "get_settings"}
```

Response:
```json
{
  "type": "response",
  "command": "get_settings",
  "success": true,
  "data": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "high",
    "steeringMode": "one-at-a-time",
    "followUpMode": "one-at-a-time",
    "compactionEnabled": true,
    "retryEnabled": true,
    "imageAutoResize": true,
    "blockImages": false,
    "enableSkillCommands": true,
    "autoLoadNestedContext": false,
    "trustedContextFolders": ["/home/user/src/my-company"],
    "effectiveTrustedContextRoots": ["/home/user/src/my-company"],
    "transport": "sse",
    "hideThinkingBlock": false,
    "agentModels": {
      "Explore": ["anthropic/sonnet", "openai/gpt-5"]
    }
  }
}
```

`defaultProvider`, `defaultModel`, and `defaultThinkingLevel` are absent if never set. `agentModels` is the merged global + project view; project entries win per agent name.

`trustedContextFolders` is the raw global configured list, including invalid legacy paths that are ignored fail-closed. `effectiveTrustedContextRoots` is the canonical, existing root set actually enforced after `~` expansion, native `realpath`, deduplication, and ancestor subsumption. `autoLoadNestedContext` defaults to `false`; when `true` it is global expert trust-all for every resolvable target, not a project override. Project `.dreb/settings.json` cannot affect any of these three fields.

#### set_settings

Update persistent default settings. Takes a partial payload — only the supplied keys change. The whole payload is validated before anything is applied: on any invalid field, nothing changes and the response is an explicit error. Writes target the global settings file (same scope as every runtime setter).

```json
{"type": "set_settings", "settings": {"defaultThinkingLevel": "low", "retryEnabled": false}}
```

Replace the global trusted-root list atomically (paths must be existing directories and are persisted as canonical roots):

```json
{"type": "set_settings", "settings": {"trustedContextFolders": ["/home/user/src/my-company"]}}
```

Set `autoLoadNestedContext: true` only as an expert global trust-all choice: it permits lazy context from any resolvable directory, including untrusted prompt-injection content. `set_settings` writes this policy globally even when the RPC session has project settings; project `.dreb/settings.json` cannot add, override, or enable it. Active processes use the result for later lazy loads, not to retract prior injections. The separate initial upward scan from the launch cwd is unaffected.

Setting the default model (both keys required together, validated against available models — the provider must have credentials configured, same rule as `set_model`):

```json
{"type": "set_settings", "settings": {"defaultProvider": "anthropic", "defaultModel": "claude-sonnet-4-5"}}
```

Setting per-agent model fallback lists:

```json
{
  "type": "set_settings",
  "settings": {
    "agentModels": {
      "Explore": ["anthropic/sonnet", "openai/gpt-5"],
      "code-reviewer": []
    }
  }
}
```

For `agentModels`, a non-empty array writes the global fallback list for that agent. An empty array removes the global entry, so that agent uses its agent-definition default unless a project-level override exists.

Response is the full settings snapshot after the write (same shape as `get_settings`), plus `warnings` when the write was accepted but a project-level override shadows part of it:

```json
{
  "type": "response",
  "command": "set_settings",
  "success": true,
  "data": {
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "low",
    "steeringMode": "one-at-a-time",
    "followUpMode": "one-at-a-time",
    "compactionEnabled": true,
    "retryEnabled": false,
    "imageAutoResize": true,
    "blockImages": false,
    "enableSkillCommands": true,
    "autoLoadNestedContext": false,
    "trustedContextFolders": ["/home/user/src/my-company"],
    "effectiveTrustedContextRoots": ["/home/user/src/my-company"],
    "transport": "sse",
    "hideThinkingBlock": false,
    "agentModels": {}
  }
}
```

Project-shadow warning example (the global write still lands, but the returned merged `agentModels.Explore` remains the project value until `.dreb/settings.json` is edited):

```json
{
  "type": "response",
  "command": "set_settings",
  "success": true,
  "data": {
    "steeringMode": "one-at-a-time",
    "followUpMode": "one-at-a-time",
    "compactionEnabled": true,
    "retryEnabled": true,
    "imageAutoResize": true,
    "blockImages": false,
    "enableSkillCommands": true,
    "autoLoadNestedContext": false,
    "trustedContextFolders": [],
    "effectiveTrustedContextRoots": [],
    "transport": "sse",
    "hideThinkingBlock": false,
    "agentModels": {
      "Explore": ["project/model"]
    },
    "warnings": [
      "A project-level agentModels override for \"Explore\" (.dreb/settings.json) takes precedence — this change to global settings will have no effect. Edit the project settings file to change it."
    ]
  }
}
```

Valid keys and values:

| Key | Values |
|-----|--------|
| `defaultProvider` + `defaultModel` | Must be supplied together; must match a model from `get_available_models` |
| `defaultThinkingLevel` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` (validated against the full set — a stored default is not tied to the current model's capabilities) |
| `steeringMode` | `"all"`, `"one-at-a-time"` |
| `followUpMode` | `"all"`, `"one-at-a-time"` |
| `compactionEnabled` | boolean |
| `retryEnabled` | boolean |
| `imageAutoResize` | boolean |
| `blockImages` | boolean |
| `enableSkillCommands` | boolean |
| `autoLoadNestedContext` | boolean; global-only expert trust-all for lazy nested/out-of-cwd loading; defaults to `false` |
| `trustedContextFolders` | Replaces the global list atomically. Array of non-empty paths that expand to absolute, existing directories; each is canonicalized with native `realpath`, then deduplicated/subsumed. Relative, missing, non-directory, and broken-symlink entries are rejected. |
| `transport` | `"sse"`, `"websocket"`, `"auto"` |
| `hideThinkingBlock` | boolean |
| `agentModels` | Plain object mapping agent names to arrays of non-empty model id strings; empty arrays remove the global entry for that agent |

Errors are explicit `success: false` responses (nothing is applied on any of them):

- Missing/empty payload: `set_settings requires at least one setting to change`
- Unknown key: `Unknown settings key(s): ...`
- Invalid enum value: `Invalid defaultThinkingLevel: "extreme". Valid values: off, minimal, low, medium, high, xhigh`
- Invalid transport: `Invalid transport: "http". Valid values: sse, websocket, auto`
- Non-boolean toggle: `Invalid retryEnabled: "yes". Must be a boolean`
- Invalid `agentModels` object: `Invalid agentModels: must be a plain object mapping agent names to model fallback arrays`
- Invalid `agentModels` entry (the offending agent key is named): `Invalid agentModels["Explore"]: expected an array of non-empty strings`
- Invalid trusted-root list: `trustedContextFolders must be an array of non-empty path strings` or `Invalid trustedContextFolders[0]: path must be absolute after ~ expansion` / `path must be an existing directory`
- Provider without model (or vice versa): `defaultProvider and defaultModel must be set together`
- Unavailable model: `Model not found: provider/model-id`
- Corrupt settings file: `Cannot write settings: the global settings file failed to load (fix or remove the corrupt settings.json first)` — without this guard the write would silently no-op
- Write failure (I/O error): `Failed to persist settings: ...`

Unlike `set_thinking_level` (which silently clamps to the current model's capabilities), `set_settings` rejects invalid values loudly — a dashboard needs the error, not a silent correction.

#### evaluate_context_trust

Evaluate one directory against the current **global** lazy nested-context policy. This is useful for a Files view; it does not load context or change settings.

```json
{"type": "evaluate_context_trust", "path": "/home/user/src/my-company/package"}
```

Success response:

```json
{
  "type": "response",
  "command": "evaluate_context_trust",
  "success": true,
  "data": {
    "canonicalTarget": "/home/user/src/my-company/package",
    "state": "trusted-root",
    "grantingRoot": "/home/user/src/my-company"
  }
}
```

`canonicalTarget` is the existing directory after strict native `realpath`. `state` is exactly one of:

- `"untrusted"` — no global root covers the target.
- `"trusted-root"` — a configured canonical root covers it; `grantingRoot` is present, including for inherited descendant access.
- `"unrestricted"` — global `autoLoadNestedContext` is true; `grantingRoot` is omitted because folder roots are not the grant.

Invalid paths return `success: false`: `path` must be a non-empty string, absolute after `~` expansion, and an existing directory. Error text is prefixed `Invalid context trust path: ` (for example, `Invalid context trust path: path must be an existing directory`). Symlinks are resolved before evaluation, so a lexical descendant that resolves outside a trusted root evaluates as untrusted.

#### trust_context_folder

Add a directory as a global trusted root, then durably flush the settings write. The request path has the same strict validation and canonicalization as `evaluate_context_trust`.

```json
{"type": "trust_context_folder", "path": "/home/user/src/my-company"}
```

Success response (the nested `settings` object is abbreviated here to its trust fields):

```json
{
  "type": "response",
  "command": "trust_context_folder",
  "success": true,
  "data": {
    "evaluation": {
      "canonicalTarget": "/home/user/src/my-company",
      "state": "trusted-root",
      "grantingRoot": "/home/user/src/my-company"
    },
    "addedRoot": "/home/user/src/my-company",
    "settings": {
      "autoLoadNestedContext": false,
      "trustedContextFolders": ["/home/user/src/my-company"],
      "effectiveTrustedContextRoots": ["/home/user/src/my-company"]
    }
  }
}
```

`settings` is the complete `get_settings` snapshot after the durable global write. `addedRoot` is the canonical target when it is retained as a root; it is omitted when an existing ancestor already covers that target. Existing malformed legacy roots are discarded by this mutation; the resulting root list is canonical, deduplicated, and ancestor-subsumed. Invalid paths use the same `Invalid context trust path: ...` errors. A corrupt global settings file or failed durable write returns `success: false` with `Cannot write settings: ...` or `Failed to persist settings: ...`; no merely in-memory trust is reported as success.

#### untrust_context_folder

Remove the actual canonical root granting trust to a target, rather than only removing a selected descendant. This is the companion for an inherited Files-view trust badge.

```json
{"type": "untrust_context_folder", "path": "/home/user/src/my-company/package"}
```

If `/home/user/src/my-company` grants this descendant's access, a successful response is (with `settings` abbreviated to its trust fields):

```json
{
  "type": "response",
  "command": "untrust_context_folder",
  "success": true,
  "data": {
    "evaluation": {
      "canonicalTarget": "/home/user/src/my-company/package",
      "state": "untrusted"
    },
    "removedRoot": "/home/user/src/my-company",
    "settings": {
      "autoLoadNestedContext": false,
      "trustedContextFolders": [],
      "effectiveTrustedContextRoots": []
    }
  }
}
```

`removedRoot` is the canonical root removed for the target and therefore revokes its descendants too. If the target was already `untrusted`, this is a successful no-op: `settings` and an `untrusted` evaluation are returned without `removedRoot`. If global expert trust-all is enabled, it fails rather than pretending a folder change can narrow it:

```json
{"type":"response","command":"untrust_context_folder","success":false,"error":"Cannot untrust a context folder while unrestricted nested context loading is enabled; disable autoLoadNestedContext first"}
```

Invalid paths and write failures have the same semantics as `trust_context_folder`.

#### remove_trusted_context_folder

Remove a configured global trusted-folder string by **exact** match, then durably flush the settings write. This is intentionally different from `untrust_context_folder`: the request path is treated as the configured string to delete and performs no directory/path resolution — no `~` expansion, absolute-path requirement, directory existence check, symlink resolution, canonicalization, or granting-root lookup.

```json
{"type": "remove_trusted_context_folder", "path": "/legacy/or/moved/path"}
```

Success response (the nested `settings` object is abbreviated here to its trust fields):

```json
{
  "type": "response",
  "command": "remove_trusted_context_folder",
  "success": true,
  "data": {
    "settings": {
      "autoLoadNestedContext": false,
      "trustedContextFolders": [],
      "effectiveTrustedContextRoots": []
    },
    "removedFolder": "/legacy/or/moved/path"
  }
}
```

`settings` is the complete `get_settings` snapshot after the durable global write. `removedFolder` is the configured folder string requested for exact removal; the command is a successful no-op if the exact string was not present. Only a non-empty string `path` is required, so this command can revoke invalid, legacy, or stale configured entries that `untrust_context_folder` cannot validate or resolve. It is not gated by global expert trust-all (`autoLoadNestedContext: true`), because it edits the configured list directly rather than pretending to narrow unrestricted loading. A corrupt global settings file or failed durable write returns `success: false` with `Cannot write settings: ...` or `Failed to persist settings: ...`; no merely in-memory trust removal is reported as success.

All four context-trust commands concern only future lazy nested/out-of-cwd loads in active main/subagent processes; they never alter the separate initial upward scan or retract context already injected into a conversation.

### Version

#### get_version

Get the dreb version.

```json
{"type": "get_version"}
```

Response:
```json
{
  "type": "response",
  "command": "get_version",
  "success": true,
  "data": {"version": "1.7.4"}
}
```

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do NOT include an `id` field (only responses do).

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | Agent completes (includes all generated messages) |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `stream_retry` | Stream dropped mid-turn; retrying (partial output discarded) |
| `length_retry` | Response hit the token limit; retrying with a larger budget |
| `auto_compaction_start` | Auto-compaction begins |
| `auto_compaction_end` | Auto-compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `background_agent_start` | Background subagent launched (includes `sessionDir`) |
| `background_agent_end` | Background subagent finished (includes `sessionFile` when known) |
| `background_agent_event` | Relayed event from a background subagent's own stream |
| `parent_paused_for_background_agents` | Parent paused waiting on background agents |
| `session_name_changed` | Session display name changed (manual rename, extension rename, or auto-title) |
| `tasks_update` | Session task list atomically replaced (each task has `id`, `title`, and status) |
| `dashboard_snapshot_barrier` | Ordering marker emitted immediately before a successful `get_dashboard_snapshot` response; pair only the matching `snapshotId` (see [Dashboard snapshots](#get_dashboard_snapshot)) |
| `suggest_next` | Agent suggested a next command |
| `extension_error` | Extension threw an error |

Treat the event union as open — dispatch on `type` and ignore unknown values
rather than validating against a closed list; new event types may be added.

### agent_start

Emitted when the agent begins processing a prompt. Includes the resolved model.

```json
{"type": "agent_start", "model": {"provider": "anthropic", "id": "claude-sonnet-4-20250514"}}
```

### agent_end

Emitted when the agent completes. Contains all messages generated during this run.

```json
{
  "type": "agent_end",
  "messages": [...]
}
```

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains both the partial message and a streaming delta event.

```json
{
  "type": "message_update",
  "message": {...},
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello ",
    "partial": {...}
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `start` | Message generation started |
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |
| `done` | Message complete (reason: `"stop"`, `"length"`, `"toolUse"`) |
| `error` | Error occurred (reason: `"aborted"`, `"error"`) |

Example streaming a text response:
```json
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello","partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world","partial":{...}}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world","partial":{...}}}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### auto_compaction_start / auto_compaction_end

Emitted when automatic compaction runs (when context is nearly full).

```json
{"type": "auto_compaction_start", "reason": "threshold"}
```

The `reason` field is `"threshold"` (context getting large) or `"overflow"` (context exceeded limit).

```json
{
  "type": "auto_compaction_end",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### background_agent_start / background_agent_end / background_agent_event

Lifecycle and live-observability events for background subagents (the `subagent` tool's background mode).

`background_agent_start` fires at launch. `sessionDir` is the directory the child will write its session JSONL into (per-launch, known before spawn):

```json
{
  "type": "background_agent_start",
  "agentId": "a1b2c3d4e5f6",
  "agentType": "Explore",
  "taskSummary": "Explore task 1/2",
  "sessionDir": "/home/user/.dreb/agent/subagent-sessions/a1b2c3d4e5f6"
}
```

`background_agent_end` fires after the result is delivered to the parent agent. `sessionFile` is the child's session JSONL path when one was written:

```json
{
  "type": "background_agent_end",
  "agentId": "a1b2c3d4e5f6",
  "agentType": "Explore",
  "success": true,
  "sessionFile": "/home/user/.dreb/agent/subagent-sessions/a1b2c3d4e5f6/2026-07-07T12-00-00-000Z_uuid.jsonl"
}
```

`background_agent_event` relays every JSONL event the child process emits (the same event union documented here, plus the initial session header), verbatim, tagged with the child's `agentId`. This is the live-transcript transport for observers like the dashboard — no session-file tailing needed. Streaming children emit `message_update` deltas at high frequency; consumers that fan events out further (e.g. over a network) should batch or throttle:

```json
{
  "type": "background_agent_event",
  "agentId": "a1b2c3d4e5f6",
  "event": {"type": "tool_execution_start", "toolName": "read", "args": {"path": "src/index.ts"}}
}
```

`parent_paused_for_background_agents` fires when the parent agent pauses because its background-agent turn guardrail was hit while agents are still running:

```json
{
  "type": "parent_paused_for_background_agents",
  "runningAgentCount": 2,
  "turnsUsed": 10,
  "turnLimit": 10
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The client does not need to track timeouts.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string arrays are supported in RPC mode; component factories are ignored.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "dreb - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "isError": false,
  "timestamp": 1733234567890
}
```

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["dreb", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("dreb", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
