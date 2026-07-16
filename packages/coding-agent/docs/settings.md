# Settings

dreb uses JSON settings files with project settings overriding global settings, except where a setting is explicitly global-only (notably nested-context trust).

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

At startup, dreb always performs an **initial upward scan** from the launch cwd for `AGENTS.md`/`CLAUDE.md`. This is separate from lazy nested/out-of-cwd loading and is not enabled, disabled, or scoped by either context setting below. It is not a claim that the initial scan has a fixed boundary: it follows the startup upward-walk behavior for that cwd.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `context.trustedFolders` | string[] | `[]` | **Global-only.** Explicit existing directory roots whose canonical descendants may lazy-load context |
| `context.autoLoadNested` | boolean | `false` | **Global-only expert trust-all.** Allow lazy loading from every resolvable directory |

Both settings belong only in `~/.dreb/agent/settings.json`. Project `.dreb/settings.json` cannot enable unrestricted loading, add trusted roots, override global roots, or otherwise widen this trust boundary.

#### `context.trustedFolders`

Use explicit roots for directories whose instructions you control:

```json
{
  "context": {
    "trustedFolders": ["~/src/my-company", "/srv/controlled-repos"]
  }
}
```

Each root authorizes itself and its descendants for lazy loading. Paths are expanded (`~` is supported) and canonically resolved with native `realpath`; the target is independently canonicalized for every decision. Roots must be absolute after expansion, existing directories, and must not be broken symlinks. Invalid/missing legacy entries are ignored fail-closed; RPC/settings updates reject invalid entries atomically. Canonical duplicates are deduplicated, and a descendant root is subsumed by its trusted ancestor. This realpath matching prevents symlink escape: a path that is lexically below a trusted folder but resolves outside it is not trusted.

For a trusted target, the first matching path-bearing tool (`read`, `edit`, `write`, `grep`, `find`, `ls`) — or `bash` beginning with `cd <dir>` — can append its context to the tool result. The walk is bounded by the trusted root (or the normal cwd/repository/context-file ceiling when expert trust-all is in effect). Main agents and subagents read the same global policy. Active processes re-read it for later lazy-load decisions, so a trust/untrust change affects **future** loads without a restart; text already injected into a conversation cannot be retracted.

#### `context.autoLoadNested`

**Expert setting — prompt-injection warning.** Set this to `true` only in global settings to allow lazy loading from **any** resolvable target directory:

```json
{
  "context": {
    "autoLoadNested": true
  }
}
```

This includes untrusted or third-party repositories and can inject prompt-injection content. Prefer `trustedFolders`; leave this setting `false` unless you intentionally trust all such targets. A project settings file cannot enable it.

For either permitted lazy-load path, each context file is realpath-deduplicated and injected at most once per session; files already obtained during the initial upward scan are not repeated. If the triggering tool already returns a context file in full, it is marked loaded without a duplicate injection. Auto-loaded content is secret-scrubbed before injection and is appended after extension `tool_result` transforms, so those transforms intentionally do not see it. See [Context Files](../README.md#context-files).

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

Project settings (`.dreb/settings.json`) override global settings. Nested objects are merged. **Exception:** `context.trustedFolders` and `context.autoLoadNested` are global-only security policy: project settings cannot add, replace, override, or enable either one. Nested context from the initial startup upward scan remains separate from this lazy-load policy.

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
