dreb is an open-source terminal coding agent, forked from [pi-mono](https://github.com/badlogic/pi-mono) (itself derived from Claude Code). It has *fewer* features than Claude Code by design — the bet is that a small, hackable core you can shape beats a large feature set you can't.

Claude Code is a great product. dreb isn't trying to compete on features — it's trying to compete on flexibility. The core is kept minimal; what you'd find baked into other tools, you build here with [skills](#skills) (markdown workflows), [extensions](#extensions) (TypeScript), or install from third-party [packages](#packages).

Concretely, dreb ships *without* things Claude Code has — and that's intentional:

- **No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support.
- **No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions).
- **No plan mode.** Write plans to files, or build it with extensions, or install a package.
- **No background bash in the main agent.** The main agent runs commands synchronously. For parallel work, use the `subagent` tool — each subagent runs as an independent process with its own tools.

What you get in exchange: a skill system, an extension API, custom agent definitions, custom provider support (route through any proxy, use any API-compatible backend), and a subagent system for parallel work. From those primitives, you build what you need — and share it with others via git or npm.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Memory](#memory)
- [Task Tracking](#task-tracking)
- [Semantic Search](#semantic-search)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Packages](#packages)
- [Programmatic Usage](#programmatic-usage)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g @dreb/coding-agent
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
dreb
```

Or use your existing subscription:

```bash
dreb
/login  # Then select provider
```

Or use a custom provider (corporate proxy, Bedrock, etc.) — see [Custom providers & models](#providers--models).

Then just talk to dreb. All 10 built-in tools are enabled by default: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, and `subagent`. Use `--tools` to restrict to a subset (e.g., `--tools read,grep,find,ls` for read-only). Three additional tools — `search`, `skill`, and `tasks_update` — are always active. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [packages](#packages).

**Also available:** [`@dreb/telegram`](https://www.npmjs.com/package/@dreb/telegram) — run dreb as a Telegram bot (`npm install -g @dreb/telegram`).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

### Building from source

```bash
git clone https://github.com/aebrer/dreb.git
cd dreb
npm install
npm run build
npm link -w packages/coding-agent
```

---

## Providers & Models

For each built-in provider, dreb maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Kimi For Coding
- MiniMax
- MiniMax (China)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.dreb/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (path, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from the current branch |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/buddy` | Terminal companion — hatch, pet, reroll, set model, or hide. See [docs/buddy.md](docs/buddy.md) |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit`, `/exit` | Quit dreb |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.dreb/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so dreb can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session.md](docs/session.md) for file format.

### Management

Sessions auto-save to `~/.dreb/agent/sessions/` organized by working directory.

```bash
dreb -c                  # Continue most recent session
dreb -r                  # Browse and select from past sessions
dreb --no-session        # Ephemeral mode (don't save)
dreb --session <path>    # Use specific session file or ID
dreb --fork <path>       # Fork specific session file or ID into a new session
```

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press `L` (Shift+L) to label entries as bookmarks

**`/fork`** - Create a new session file from the current branch. Opens a selector, copies history up to the selected point, and places that message in the editor for modification.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.dreb/agent/settings.json` | Global (all projects) |
| `.dreb/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

---

## Context Files

dreb loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.dreb/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

### System Prompt

Replace the default system prompt with `.dreb/SYSTEM.md` (project) or `~/.dreb/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Memory

dreb has a persistent, file-based memory system. Memory survives across sessions and helps the model recall user preferences, past decisions, project context, and pointers to external resources.

### How it works

Memory is convention-based — no dedicated tool. The system prompt teaches the model the memory format; the model uses the standard `read`, `write`, and `edit` tools to manage memory files. Memory indexes (`MEMORY.md`) are loaded at session start and injected into the system prompt.

### Locations

| Scope | Directory | Loaded |
|-------|-----------|--------|
| Global | `~/.dreb/memory/` | Every session |
| Project | `<project-root>/.dreb/memory/` | When working in that project |

Project identity is determined by git repo root. The global memory directory is auto-created on first session; project directories are created on demand by the model.

### Memory entries

Each memory is a Markdown file with YAML frontmatter:

```markdown
---
name: descriptive-name
description: One-line description for relevance matching
type: user-preferences
---

Content of the memory entry.
```

Four types: `user-preferences` (who the user is), `good-practices` (how to approach work), `project` (ongoing work context), `navigation` (pointers to external resources).

### MEMORY.md index

Each memory directory has a `MEMORY.md` file that serves as an index. Only the first 200 lines are loaded at session start — keep it concise:

```markdown
- [User role](user_role.md) — Python dev, generative art background
- [CI parity](feedback_ci_parity.md) — run tsgo --noEmit locally, not just tests
```

### Claude Code compatibility

dreb reads existing Claude Code memory for the current project from `~/.claude/projects/` (read-only), with source labeling and a warning about Claude Code-specific references that may not apply to dreb.

---

## Task Tracking

The `tasks_update` tool lets the model maintain a visible task list during multi-step work. Tasks appear in a TUI panel with status indicators (☐ pending, ⧖ in progress, ☑ completed).

The tool uses a full-replacement model — the model sends the complete task list on each call, no incremental updates. The TUI panel is visible by default and renders when active tasks exist. It auto-hides when the task list is empty or all tasks are completed. Toggle visibility with the `app.tasks.toggle` keybinding (unbound by default, configurable in [keybindings](docs/keybindings.md)). The panel displays up to 10 tasks at a time; overflow shows as "... and N more".

Task tracking is prompt-driven: the system prompt includes guidelines for when to use it (3+ step work), concise titles, and a maximum of 20 tasks.

---

## Semantic Search

The `search` tool provides natural language queries over the codebase using embeddings and full-text search. It supports identifier queries (e.g., `AuthMiddleware`), natural language (e.g., `where is rate limiting handled`), and path queries (e.g., `src/auth/`).

**Parameters:** `query` (required), `path` (restrict to subdirectory), `limit` (max results, default 20), `projectDir` (index/search a different directory instead of cwd — useful for Telegram sessions where cwd is `~/`), `rebuild` (force a clean re-index when results look stale or corrupt).

**How it works:** The first query builds a project index (typically 10–60s, longer for very large repos). Subsequent queries use the cached index, with incremental re-indexing for changed files (mtime-based). Each unique `projectDir` gets its own independent index.

**Indexing pipeline:**
- AST-aware code chunking via tree-sitter (TypeScript, JavaScript, Python, Go, Rust, Java, C, C++) — extracts functions, classes, methods, and exports as individual chunks
- Format-aware text chunking for non-code files (Markdown by heading, YAML/JSON/TOML by top-level key)
- Local embeddings via all-MiniLM-L6-v2 (~23MB model, auto-downloaded on first use, cached at `~/.dreb/agent/models/`)

**Ranking:** Uses POEM (Pareto-Optimal Embedding-based Multiranking) with 6 metrics: FTS5 BM25, vector cosine similarity, path match, symbol match, import graph proximity, and git recency. Short identifier queries bias toward exact text matches; long natural language queries bias toward vector similarity.

**Storage:** Project index at `.dreb/index/`, memory files indexed alongside code. Add `**/.dreb/` to your project's `.gitignore`. Works offline after the initial model download.

**Requirements:** Node.js 22+ (uses built-in `node:sqlite`). On older Node versions the tool is silently unavailable — no crash, it simply doesn't register. Zero native addons — uses `web-tree-sitter` (WASM) and `@huggingface/transformers` (WASM).

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.dreb/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.dreb/agent/prompts/`, `.dreb/prompts/`, or a [package](#packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name`, or the agent invokes them automatically via the built-in `skill` tool when a task matches.

```markdown
<!-- ~/.dreb/agent/skills/my-skill/SKILL.md -->
---
name: my-skill
description: Use this skill when the user asks about X.
argument-hint: "<topic>"
---

## Steps
1. Do this with $1
2. Then that
```

Skills support [content substitution](docs/skills.md#content-substitution) (`$1`, `$ARGUMENTS`, `${DREB_SKILL_DIR}`, etc.) and frontmatter fields like `argument-hint`, `user-invocable`, and `disable-model-invocation`.

Place in `~/.dreb/agent/skills/`, `~/.agents/skills/`, `.dreb/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [package](#packages) to share with others. See [docs/skills.md](docs/skills.md).

dreb ships with **mach6** — a built-in development workflow (issue → plan → push → review → fix → publish) that uses GitHub as shared memory and multi-agent code review. See [docs/mach6.md](docs/mach6.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend dreb with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (dreb: ExtensionAPI) {
  dreb.registerTool({ name: "deploy", ... });
  dreb.registerCommand("stats", { ... });
  dreb.on("tool_call", async (event, ctx) => { ... });
}
```

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Plan mode and custom agent workflows
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make dreb look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.dreb/agent/extensions/`, `.dreb/extensions/`, or a [package](#packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and dreb immediately applies changes.

Place in `~/.dreb/agent/themes/`, `.dreb/themes/`, or a [package](#packages) to share with others. See [docs/themes.md](docs/themes.md).

### Packages

Bundle and share extensions, skills, prompts, and themes via npm or git.

> **Note:** Third-party packages can include extensions (arbitrary code) and skills (model instructions). Skim what you're installing, same as any other dependency.

```bash
dreb install npm:@foo/my-tools
dreb install npm:@foo/my-tools@1.2.3      # pinned version
dreb install git:github.com/user/repo
dreb install git:github.com/user/repo@v1  # tag or commit
dreb install git:git@github.com:user/repo
dreb install git:git@github.com:user/repo@v1  # tag or commit
dreb install https://github.com/user/repo
dreb install https://github.com/user/repo@v1      # tag or commit
dreb install ssh://git@github.com/user/repo
dreb install ssh://git@github.com/user/repo@v1    # tag or commit
dreb remove npm:@foo/my-tools
dreb uninstall npm:@foo/my-tools          # alias for remove
dreb list
dreb update                               # skips pinned packages
dreb config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.dreb/agent/git/` (git) or global npm. Use `-l` for project-local installs (`.dreb/git/`, `.dreb/npm/`). If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `dreb` key to `package.json`:

```json
{
  "name": "my-dreb-package",
  "keywords": ["dreb-package"],
  "dreb": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `dreb` manifest, dreb auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@dreb/coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: AuthStorage.create(),
  modelRegistry: new ModelRegistry(authStorage),
});

await session.prompt("What files are in the current directory?");
```

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
dreb --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## CLI Reference

```bash
dreb [options] [@files...] [messages...]
```

### Package Commands

```bash
dreb install <source> [-l]     # Install package, -l for project-local
dreb remove <source> [-l]      # Remove package
dreb uninstall <source> [-l]   # Alias for remove
dreb update [source]           # Update packages (skips pinned)
dreb list                      # List installed packages
dreb config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, dreb also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | dreb -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path>` | Use specific session file or partial UUID |
| `--fork <path>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Comma-separated list of tools to enable (default: all) |
| `--no-tools` | Disable all built-in tools (extension tools still work) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `subagent`

Three additional tools are always active but don't appear in `--tools`:
- `search` — [semantic codebase search](#semantic-search) using natural language queries
- `skill` — invokes [skills](#skills) programmatically
- `tasks_update` — session [task tracking](#task-tracking) with TUI panel

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `--offline` | Disable startup network ops (same as `DREB_OFFLINE=1`) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
dreb @prompt.md "Answer this"
dreb -p @screenshot.png "What's in this image?"
dreb @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
dreb "List all .ts files in src/"

# Non-interactive
dreb -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | dreb -p "Summarize this text"

# Different model
dreb --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
dreb --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
dreb --model sonnet:high "Solve this complex problem"

# Limit model cycling
dreb --models "claude-*,gpt-4o"

# Read-only mode
dreb --tools read,grep,find,ls -p "Review the code"

# High thinking level
dreb --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DREB_CODING_AGENT_DIR` | Override config directory (default: `~/.dreb/agent`) |
| `DREB_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `DREB_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `DREB_OFFLINE` | Disable startup network ops (same as `--offline`) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- `packages/ai` — Core LLM toolkit (model registry, provider APIs, streaming)
- `packages/agent` — Agent framework (agent loop, event system, types)
- `packages/tui` — Terminal UI components
