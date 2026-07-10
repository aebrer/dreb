# dreb

dreb is a hackable, open-source terminal coding agent and agent runtime for people who want to own their AI development workflow. It gives you a practical coding assistant today — tools, sessions, memory, model switching, subagents, and a polished TUI — while keeping the core flexible enough to reshape with skills, extensions, packages, custom providers, and alternate frontends. Its web dashboard puts every agent session in the browser: start work at your desk, steer it from your phone.

Use dreb if you want a coding agent that can run against direct APIs, coding subscriptions, proxies, cloud providers, local models, or your own provider code; if you want workflows such as issue-to-merge automation and multi-agent review to be inspectable and replaceable; or if you want an agent runtime you can embed in a CLI, an RPC process, an SDK integration, a web dashboard, or a Telegram bot.

## Why choose dreb?

- **Every session, on every device.** The [web dashboard](#web-dashboard) is a first-party browser UI for the same sessions the terminal runs: a fleet overview of all live and past sessions across projects, full chat with steering, live subagent observability, host file access, and settings — one synchronized state on desktop and mobile. Local-only by default; remote access is Tailscale-gated with device pairing.
- **Model and provider freedom.** Authenticate with API keys or `/login` subscriptions, switch models at runtime with `/model`, scope model sets, tune thinking levels, route built-in providers through proxies, use cloud providers such as Bedrock/Vertex/Azure, or add local/proxy/custom models through [Custom Models](packages/coding-agent/docs/models.md) and [Custom Providers](packages/coding-agent/docs/custom-provider.md). See [Providers](packages/coding-agent/docs/providers.md) for the current setup list.
- **A real development workflow.** [mach6](packages/coding-agent/docs/mach6.md) is a built-in issue-to-merge workflow: assess issues, plan work, open draft PRs, implement, push progress, run multi-agent reviews, independently assess findings, fix CI or review items, and publish. Plans, reviews, and progress live on GitHub as shared memory.
- **Composable agent building blocks.** [Skills](packages/coding-agent/docs/skills.md) are markdown workflows loaded on demand; [extensions](packages/coding-agent/docs/extensions.md) are TypeScript modules for custom tools, commands, event hooks, UI components, renderers, keybindings, provider registration, permission gates, and workflow automation; [packages](packages/coding-agent/docs/packages.md) bundle skills, extensions, prompts, and themes for npm, git, or local sharing.
- **Parallel and specialized agents.** The `subagent` tool runs independent child agents in single, parallel, or chain mode. Custom agent definitions can inherit models, record child-session metadata for audit trails, and power workflows such as mach6's specialized code, error, test, completeness, and simplification reviewers. Per-agent models can be overridden via the [`agentModels` setting](packages/coding-agent/docs/agent-models.md) without editing agent definition files. The parent session's running model is exposed in its own system prompt (`You are running on: provider/id`), enabling self-aware routing decisions such as delegating to a multimodal or differently-architected subagent. While background subagents run, a guardrail pauses the parent after a few turns and surfaces a friendly, non-error notification (in the TUI and Telegram) explaining the intentional pause — configurable or disable-able via [`backgroundAgents`](packages/coding-agent/docs/settings.md#background-agents).
- **Durable context.** [Sessions](packages/coding-agent/docs/session.md) are JSONL trees with resume/continue, `/tree` navigation, `/fork`, CLI `--fork`, compaction, HTML export, and JSONL import/export. [Memory](packages/coding-agent/README.md#memory) is file-based, global + project-scoped, survives sessions, can read Claude Code project memory, and can be maintained with `/dream` memory consolidation.
- **A capable terminal workspace.** The TUI supports slash commands, file references with `@`, path completion, image paste/drag, bash shortcuts, hotkeys, settings, model cycling, steering/follow-up queues while the agent is working, token/cost/context status, custom themes, and extension-provided UI surfaces. Transcript prose, code, tool output, and agent results use terminal soft-wrap so copying from scrollback keeps long logical lines intact instead of injecting hard newlines.
- **Optional local companion.** [`/buddy`](packages/coding-agent/docs/buddy.md) hatches an Ollama-powered terminal companion with persistent state, generated personality/backstory, event reactions, idle quips, name-call responses, pet/reroll/stats commands, and a sidebar presence while you work.
- **Codebase and web understanding.** dreb includes file, grep/find/ls, bash, web search/fetch, task tracking, skill invocation, and semantic `search`. Semantic search uses AST-aware chunks, embeddings, POEM ranking, memory indexing, and also ships as [`@dreb/semantic-search`](packages/semantic-search/) with an MCP server for other harnesses. The semantic search package requires Node.js 22+.
- **Detailed usage tracking and performance logging.** dreb records per-session token usage, cost, context-window utilization, and rolling tokens-per-second performance in a local JSONL log (`~/.dreb/agent/performance.jsonl`). This data stays on your machine and can be queried via the TUI footer, Telegram `/stats`, or RPC for personal analytics and model comparison.
- **Safety and reliability primitives.** Recent dreb-specific hardening includes secret output scrubbing, sensitive-file guards, destructive-command guards, resource diagnostics surfaced in-session, warning propagation, rate-limited web search across parallel subagents, and JSON/RPC protocol hardening. Dropped provider streams are retried (discarding the partial), and responses truncated at the model's output-token limit are retried with a larger token budget — failing loudly rather than returning a silently empty or truncated result.
- **Multiple interfaces.** Run dreb as an interactive TUI, print/headless CLI, JSON event stream, RPC process, embedded [SDK](packages/coding-agent/docs/sdk.md), [web dashboard](packages/coding-agent/docs/dashboard.md), or [Telegram bot](packages/telegram/).

## Quick Start

> **Node.js 22 LTS is required.** dreb relies on SSE streaming behavior that is stable in Node 22 LTS. Node 24 and Node 26 are known to break provider streaming due to changes in ReadableStream buffering, which causes every provider to fail with **"request ended without sending any chunks"**. If you see that error, switch to Node 22 LTS.

### Building from source (recommended)

```bash
git clone https://github.com/aebrer/dreb.git
cd dreb
npm install
npm run build
npm link -w packages/coding-agent
```

See the full coding-agent docs in [packages/coding-agent](packages/coding-agent/).

### Installing from npm

```bash
npm install -g @dreb/coding-agent
```

Authenticate with an API key and start the TUI:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
dreb
```

Or use a coding subscription such as ChatGPT/Codex, GitHub Copilot, Gemini CLI, Antigravity, or Kimi:

```bash
dreb
/login
```

Or route through a custom provider — corporate proxy, OpenAI-compatible local server such as Ollama/LM Studio/vLLM, Bedrock proxy, Anthropic-compatible endpoint, Google-compatible endpoint, or extension-registered provider. See [Custom Models](packages/coding-agent/docs/models.md) and [Providers](packages/coding-agent/docs/providers.md).

Platform notes: [Windows](packages/coding-agent/docs/windows.md), [Termux/Android](packages/coding-agent/docs/termux.md), [tmux](packages/coding-agent/docs/tmux.md), [terminal setup](packages/coding-agent/docs/terminal-setup.md), and [shell aliases](packages/coding-agent/docs/shell-aliases.md).

**Bun users:** Bun's lockfile can cache stale versions of `@dreb/*` packages, causing import errors after upgrades. If you hit missing export errors with `bunx dreb`, clear the cache and re-install:

```bash
bun pm cache rm
bunx --force dreb
```

### Troubleshooting

- **"request ended without sending any chunks" on every provider** — Your Node version is likely too new. Switch to **Node.js 22 LTS**. Node 26 in particular changed ReadableStream buffering in a way that breaks the Anthropic and OpenAI SDK stream parsers dreb uses.

## Core capabilities

### Tools and interaction

dreb ships with 12 built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `subagent`, `wait`, and `search` (semantic codebase search). Two more tools are always active: `skill` for loading workflows, and `tasks_update` for visible task tracking. `suggest_next` (ghost text command suggestions, Tab to accept) is active by default but excluded when `--tools` is specified.

Interactive mode adds slash commands such as `/model`, `/settings`, `/resume`, `/tree`, `/fork`, `/compact`, `/dream`, `/buddy`, `/export`, `/reload`, `/hotkeys`, and `/changelog`. The message queue lets you steer a running agent or queue follow-up work without waiting for the current turn to finish.

### Provider and model routing

dreb supports both subscription and API-key providers, with model metadata updated in releases. Current provider docs cover subscriptions such as Codex, GitHub Copilot, Gemini CLI, Antigravity, and Kimi; API-key providers such as Anthropic, OpenAI, Azure OpenAI, Google Gemini/Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, ZAI, OpenCode, Hugging Face, Kimi, and MiniMax; plus custom local/proxy providers.

Custom model configuration can override built-in provider base URLs, merge custom models into built-in providers, set compatibility flags for OpenAI-compatible servers, resolve API keys from shell commands or environment variables, and register providers dynamically from extensions.

Provider-specific docs include Kimi vision notes that distinguish the Kimi Code OAuth endpoint, the Kimi API-key coding provider, first-party Kimi CLI media handling, and Moonshot Open Platform vision support.

### Workflows and customization

Skills provide progressively loaded instructions for specialized tasks. They can be invoked by users as `/skill:name` or by the model through the `skill` tool, support argument substitution, and can live globally, per-project, in packages, or on the CLI.

Extensions are TypeScript modules loaded with full access to dreb's extension API. They can add or override tools, intercept tool calls, mutate provider payloads, add commands and flags, define custom keyboard shortcuts, render custom tool output, open overlays and custom editors, persist state in sessions, register providers, surface warnings, and implement custom permission or workflow gates.

Resources carry source provenance so commands, tools, skills, and prompts can be traced through autocomplete, RPC discovery, and SDK introspection.

dreb packages make those resources installable and shareable through npm, git, URLs, or local paths. Use `dreb install`, `dreb list`, `dreb update`, and `dreb config` to manage them; project-local packages can be checked into settings so teams get the same skills, extensions, prompts, and themes.

### Sessions, memory, and continuity

Sessions are persistent JSONL files with a tree structure. You can resume recent sessions, browse past sessions, branch in-place with `/tree`, fork sessions into new files, compact long conversations, import/export JSONL, export HTML, or choose a custom session directory.

Memory is just files. Global and project memory indexes are loaded into the system prompt at startup, and entries can store user preferences, good practices, project context, or navigation pointers. `/dream` backs up memory, merges duplicates, scans recent sessions for unrecorded patterns, prunes stale entries, and validates links.

Project context files (`AGENTS.md`/`CLAUDE.md`) are loaded at startup by walking up from the working directory. Nested context in subdirectories — or in a different repo a subagent visits — is auto-loaded on demand the first time a tool operates there (`context.autoLoadNested`, on by default), so per-package conventions are not silently missed. Caution: untrusted/third-party context files can be prompt-injection content; disable nested auto-load with `context.autoLoadNested: false`. Auto-loaded content is secret-scrubbed, and extension `tool_result` transforms do not see it by design. See [Context Files](packages/coding-agent/README.md#context-files).

### Interfaces and embedding

The same agent runtime powers multiple surfaces:

- **Interactive TUI** — the default terminal coding workspace.
- **Print/headless CLI** — `dreb -p` for one-shot prompts, including piped stdin.
- **JSON mode** — event stream for scripts and automation.
- **RPC mode** — strict [JSONL stdin/stdout protocol](packages/coding-agent/docs/rpc.md) for non-Node clients and custom UIs.
- **SDK** — import `@dreb/coding-agent` and create agent sessions directly in TypeScript.
- **Telegram** — `@dreb/telegram` runs dreb as a bot with sessions, model controls, file upload/download, live tool status, and visible results for user-facing tools.
- **Web dashboard** — `dreb dashboard` serves a browser UI (fleet overview of all sessions, full chat with steering, subagent observability, host file browser); local-only by default, remote via Tailscale + rotating pairing code. See [dashboard docs](packages/coding-agent/docs/dashboard.md).

### Web dashboard

The dashboard is the visual face of dreb: every agent session on the host, live in the browser, with the same fidelity as the terminal.

**One host, every screen.** The dashboard server and the TUI share the same sessions on disk and the same agent runtime. Start a refactor in the terminal, open the dashboard on your desktop to watch its subagents fan out, then pick the same session up from your phone on the couch — one synchronized state everywhere, streaming live over SSE. The layout is responsive by design: on a desktop it's a dense multi-column fleet; on a phone it prioritizes read-and-steer, because steering a running agent from wherever you are is the point.

<!-- screenshot: fleet overview, desktop (light) -->
<!-- screenshot: session view, mobile -->

**Fleet overview.** Home base is every session across every project: live sessions with status chips (running / needs-attention / idle / error), activity lines, running subagents, task progress, context usage, and model — plus past sessions grouped by project, resumable with one tap. When a session needs input, the browser tab badges and (opt-in) sends a notification.

**Full-parity session view.** Not a reduced chat client: streaming markdown, thinking blocks, bespoke tool cards (read/write/edit/bash and markdown-rendering tools), task panels, queued-message chips, image attach/paste, slash-command autocomplete, model/thinking switchers, fork-from-message, HTML export. While the agent works you can **steer** (inject into the running turn), **queue follow-ups**, or **stop** — the same queue semantics as the TUI.

<!-- screenshot: session view with tool cards + subagent strip, desktop (dark) -->

**Live subagent observability.** Background subagents are first-class: chips on the parent session, live counts on fleet cards, and a read-only drill-in transcript per agent that streams in real time and survives browser reloads.

**Host files, explicitly.** Browse the host filesystem, upload/download, create folders, and start a new session in any directory — every file operation logged server-side.

Launch locally:

```bash
dreb dashboard
# or: dreb-dashboard
```

**Remote access is explicit and Tailscale-only.** There is no LAN mode and no public exposure. Local mode binds loopback exclusively (with Host/Origin validation against DNS rebinding). Remote mode requires [Tailscale](https://tailscale.com) — from your phone on the same WiFi or from the other side of the world, the path is identical:

```bash
dreb-dashboard --remote --allow you@example.com
```

Every remote request passes fail-closed layers: tailnet identity resolution, identity allowlist (empty list denies everyone), first-login pairing with a rotating 6-digit code shown only on the host, then a signed device cookie. Paired devices are listed in settings and can be unpaired at any time. Pairing grants terminal-equivalent power — the pairing screen says so before the code is entered.

For auto-restart on Linux, install a systemd user unit. Use the absolute path from `which dreb-dashboard` for `ExecStart` (the example below matches an npm global prefix under `~/.npm-global`):

```ini
# ~/.config/systemd/user/dreb-dashboard.service
[Unit]
Description=dreb web dashboard

[Service]
ExecStart=%h/.npm-global/bin/dreb-dashboard
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dreb-dashboard
```

macOS users can run the same command under a launchd user agent; a full plist is deferred.

Full docs: [dashboard.md](packages/coding-agent/docs/dashboard.md).

## Design philosophy

dreb is a hard fork of [pi-mono](https://github.com/badlogic/pi-mono), itself derived from Claude Code. Claude Code is a great product; dreb is not trying to win by cloning every feature into a bigger built-in core. It is trying to win on control, hackability, provider choice, and inspectable workflows.

That means some features other tools bake in are intentionally left as user-space building blocks:

- **No built-in MCP client in the core.** Prefer CLI tools with clear READMEs, skills, or extensions. Separately, `@dreb/semantic-search` exposes an MCP server for other harnesses.
- **No mandatory permission-popup system.** Run in a container, rely on dreb's guards, or build the confirmation flow you want with extensions.
- **No separate plan mode primitive.** Write plans to files or GitHub, use mach6, install a package, or build your own planning UI with extensions.
- **No background bash in the main agent.** The main agent runs shell commands synchronously; parallel work belongs in subagents.

The tradeoff is a smaller core with stronger escape hatches: markdown skills, TypeScript extensions, custom agents, custom providers, installable packages, and multiple frontends.

## Why fork?

A hard fork means dreb controls the update cadence. Upstream changes do not land automatically; useful fixes can be cherry-picked, product direction can diverge, and dreb-specific work such as mach6, memory maintenance, Telegram, safety guards, and provider routing can evolve on its own schedule.

See [FORK.md](FORK.md) for details.

## Packages

| Package | Description |
|---|---|
| [`@dreb/coding-agent`](packages/coding-agent/) | CLI, TUI mode, built-in tools, sessions, memory, skills, extensions, packages, SDK/RPC, and full product docs |
| [`@dreb/ai`](packages/ai/) | LLM provider abstraction with model catalogs, OAuth/API-key providers, streaming, thinking levels, proxy/custom-provider support |
| [`@dreb/agent-core`](packages/agent/) | General-purpose agent runtime: tool loop, state, streaming, hooks, steering/follow-up queue semantics |
| [`@dreb/tui`](packages/tui/) | Terminal UI library with differential rendering, markdown/syntax rendering, editor/input components, overlays, keybindings |
| [`@dreb/semantic-search`](packages/semantic-search/) | Semantic codebase search engine with AST chunking, embeddings, POEM ranking, library API, and MCP server |
| [`@dreb/telegram`](packages/telegram/) | Telegram bot frontend for dreb over the native RPC protocol |
| [`@dreb/dashboard`](packages/dashboard/) | Web dashboard frontend with fleet overview, chat steering, subagent observability, host file browser, and Tailscale/rotating-code pairing |

## License

MIT

Contribution types: [docs/contribution-types.md](docs/contribution-types.md).
