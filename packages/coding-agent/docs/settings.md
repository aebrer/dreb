# Settings

dreb uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.dreb/agent/settings.json` | Global (all projects) |
| `.dreb/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |
| `agentModels.models` | object | - | Per-agent model fallback lists for subagents (map of agent name → ordered model IDs). See [agent-models.md](agent-models.md) |
| `modelSettings` | object | - | Per-model overrides keyed by model ID (e.g. thinking display). See [modelSettings](#modelsettings) |

#### agentModels.models

Override the model used by each subagent type without editing agent definition files. Each key is an agent type name; the value is an ordered fallback list of `provider/model` IDs (first available is used).

```json
{
  "agentModels": {
    "models": {
      "Explore": ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"],
      "Sandbox": ["anthropic/claude-haiku-3-20250422"]
    }
  }
}
```

Configurable in the TUI via `/settings` → **Agent Models**. See [agent-models.md](agent-models.md) for the full resolution order and details.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

#### modelSettings

Per-model overrides keyed by model ID. Currently supports `thinkingDisplay`, which controls
whether adaptive-thinking Claude models (Opus 4.6+, Sonnet 4.6+) return thinking summaries.

```json
{
  "modelSettings": {
    "claude-opus-4-8": { "thinkingDisplay": "summarized" }
  }
}
```

- `"summarized"` — show thinking summaries (default for adaptive models).
- `"omitted"` — hide thinking text for faster time-to-first-token; only an encrypted
  signature is returned.

Anthropic's API defaults Opus 4.7+ to `"omitted"`, so dreb sends `"summarized"` by default
on adaptive models to keep thinking visible. Set `"omitted"` here to opt into the
lower-latency behavior. The setting is **keyed by model ID**, so it is honored identically
by the main session and by any subagent that uses the same model. Non-adaptive models
ignore the setting.

Configurable in the TUI via `/settings` → **Show thinking summaries** (shown only when the
current model supports adaptive thinking).

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Tab Title

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tabTitle.enabled` | boolean | `true` | Auto-generate terminal tab title from session task |
| `tabTitle.triggerAfter` | number | `9` | Number of tool calls before generating title |
| `tabTitle.maxTitleLength` | number | `60` | Soft target length hint for generated titles (clamped to a hard cap of 300) |

After the configured number of tool calls, dreb fires a single background LLM call to summarize the session's task into a terminal tab title, then sets it via OSC 0. The title is based primarily on your actual request and current-session actions, with branch/repo/cwd metadata used only for disambiguation. `maxTitleLength` is a soft target communicated to the model (default 60); titles may run a little longer for clarity and are hard-capped at 300 characters. The TUI truncates long titles visually while the dashboard shows the full name. Only fires once per session, and never overwrites an already-named (e.g. resumed) session. If the LLM call fails, the default title remains and the failure is surfaced (shown in interactive mode, logged to stderr in RPC mode).

```json
{
  "tabTitle": {
    "enabled": true,
    "triggerAfter": 9,
    "maxTitleLength": 60
  }
}
```

### Context

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `context.autoLoadNested` | boolean | `true` | Auto-load a directory's `AGENTS.md`/`CLAUDE.md` the first time a tool operates there |

When enabled, dreb loads nested context files that the startup upward-walk misses (e.g. a `CLAUDE.md` in a monorepo subpackage, or context in a different repo a subagent visits). The first tool to touch a directory triggers a walk up to a sensible ceiling — the session cwd for in-tree targets, otherwise the outermost git repo root, otherwise the outermost directory containing a context file — and the collected files are appended to that tool's result. Each file loads at most once per session. See [Context Files](../README.md#context-files).

**Security caution:** when working across untrusted or third-party repositories, their `AGENTS.md`/`CLAUDE.md` files may be auto-injected into the agent's context, which is a prompt-injection consideration. Set `context.autoLoadNested` to `false` to disable this behavior. Auto-loaded content is secret-scrubbed before injection, but extension `tool_result` transforms do not see it because nested context is injected after those transforms for cache safety.

```json
{
  "context": {
    "autoLoadNested": true
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for exponential backoff (2s, 4s, 8s) |
| `retry.maxDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `maxDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  }
}
```

### Background Agents

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `backgroundAgents.parentTurnGuardrail` | boolean | `true` | Pause the parent agent after `parentTurnLimit` turns while background subagents are still running |
| `backgroundAgents.parentTurnLimit` | number | `3` | Parent turns allowed while background agents run before pausing |

When you launch background subagents, the parent agent keeps working and returns control to you while subagents run. The guardrail pauses the parent after `parentTurnLimit` turns so it doesn't spin ahead of results — when this happens, dreb surfaces a friendly, non-error notification in the TUI and Telegram explaining that background agents are still working and the parent paused intentionally (it resumes when they report back, or you can send a message to steer it).

Set `parentTurnGuardrail` to `false` to let the parent keep running with no turn limit while subagents work — an advanced opt-out with no upper bound on parent turns. Raise `parentTurnLimit` to relax the guardrail without fully disabling it.

```json
{
  "backgroundAgents": {
    "parentTurnGuardrail": true,
    "parentTurnLimit": 3
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |

| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |
| `forbiddenCommands` | string[] | `[]` | Additional regex patterns for commands the bash tool will refuse to run (appended to hardcoded defaults) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including `npm root -g`, installs, uninstalls, and `npm install` inside git packages. Use argv-style entries exactly as the process should be launched.

### Security

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sensitiveFilePaths` | string[] | `[]` | Additional glob patterns for sensitive file paths blocked by the read/bash guard (appended to built-in defaults) |
| `secretOutputPatterns` | `{ name, pattern }[]` | `[]` | Additional regex patterns for secret scrubbing in tool output (appended to built-in defaults) |

dreb includes two built-in layers of protection against accidental credential exposure through the tool pipeline:

**Output scrubbing** — Tool output is scanned for known secret patterns before it enters the LLM conversation. Detected secrets are replaced with `<REDACTED:pattern_name>` markers. Built-in patterns cover AWS access keys, GitHub tokens (classic and fine-grained PATs), GitLab tokens, OpenAI keys, Anthropic keys, Slack tokens, Stripe keys, URL credentials, PEM private key blocks, and OpenSSH private key blocks. Add custom patterns via `secretOutputPatterns`:

```json
{
  "secretOutputPatterns": [
    { "name": "internal_api_key", "pattern": "INTERNAL_[A-Z0-9]{32,}" }
  ]
}
```

**Sensitive file access guard** — The `read` tool and common bash file-reading commands (`cat`, `head`, `tail`, `grep`, `sed`, `base64`, etc.) are blocked from accessing known credential files. Built-in protected paths: `~/.ssh/id_*` (not `.pub`), `~/.gnupg/private-keys-v1.d/*`, `~/.dreb/secrets/*`, `~/.dreb/agent/auth.json`, `~/.aws/credentials`, `~/.config/gcloud/credentials.db`. Add custom paths via `sensitiveFilePaths` — only trailing wildcards (`*`, `/**`) are supported:

```json
{
  "sensitiveFilePaths": [
    "~/.vault/token",
    "~/.config/hub"
  ]
}
```

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths. |

```json
{ "sessionDir": ".dreb/sessions" }
```

When multiple sources specify a session directory, `--session-dir` CLI flag takes precedence, then `sessionDir` in settings.json, then extension hooks.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.dreb/agent/settings.json` resolve relative to `~/.dreb/agent`. Paths in `.dreb/settings.json` resolve relative to `.dreb`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["dreb-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "dreb-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "packages": ["dreb-skills"]
}
```

## Project Overrides

Project settings (`.dreb/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.dreb/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .dreb/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
