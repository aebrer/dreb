# dreb

dreb is a hackable, open-source terminal coding agent and agent runtime for people who want to own their AI development workflow. It gives you a practical coding assistant today — tools, sessions, memory, model switching, subagents, and a polished TUI — while keeping the core flexible enough to reshape with skills, extensions, packages, custom providers, and alternate frontends. Its web dashboard puts every agent session in the browser: start work at your desk, steer it from your phone.

Use dreb if you want a coding agent that can run against direct APIs, coding subscriptions, proxies, cloud providers, local models, or your own provider code; if you want workflows such as issue-to-merge automation and multi-agent review to be inspectable and replaceable; or if you want an agent runtime you can embed in a CLI, an RPC process, an SDK integration, a web dashboard, or a Telegram bot.

## Why choose dreb?

- **Every session, on every device.** The [web dashboard](#web-dashboard) is a first-party browser UI for the same sessions the terminal runs: a fleet overview of all live and past sessions across projects, full chat with steering, live subagent observability, host file access, dreb memory management, and settings — one synchronized state on desktop and mobile. Local-only by default; remote access is Tailscale-gated with device pairing.
- **Model and provider freedom.** Authenticate with API keys or `/login` subscriptions, switch models at runtime with `/model`, scope model sets, and tune model-aware thinking levels through `xhigh` plus a model-aware `max` tier. Codex `ultra` is orchestration (`max` plus local multi-agent work), not a raw provider effort. Route built-in providers through proxies, use cloud providers such as Bedrock/Vertex/Azure, or add local/proxy/custom models through [Custom Models](packages/coding-agent/docs/models.md) and [Custom Providers](packages/coding-agent/docs/custom-provider.md). See [Providers](packages/coding-agent/docs/providers.md) for the current setup list.
- **A real development workflow.** [mach6](packages/coding-agent/docs/mach6.md) is a built-in issue-to-merge workflow: assess issues, plan work, open draft PRs, implement, push progress, run multi-agent reviews, independently assess findings, fix CI or review items, and publish. Plans, reviews, and progress live on GitHub as shared memory.
- **Composable agent building blocks.** [Skills](packages/coding-agent/docs/skills.md) are markdown workflows loaded on demand; [extensions](packages/coding-agent/docs/extensions.md) are TypeScript modules for custom tools, commands, event hooks, UI components, renderers, keybindings, provider registration, permission gates, and workflow automation; [packages](packages/coding-agent/docs/packages.md) bundle skills, extensions, prompts, and themes for npm, git, or local sharing.
- **Parallel and specialized agents.** The optional `subagent` tool runs role-matched work in independent child agents using single, parallel, or chain mode. Omitting the agent type selects `Explore`, which retrieves concrete evidence such as files, symbols, documentation, call sites, exact snippets, and explicit data flows; the primary agent retains root-cause diagnosis, requirements interpretation, design, implementation recommendations, planning, synthesis, and final conclusions. Parallel and chain modes do not relax that boundary, while specialized agents continue to perform the broader work in their own definitions. Custom agent definitions can inherit models, record child-session metadata for audit trails, and power workflows such as mach6's specialized reviewers. Per-agent models and per-request thinking remain explicit controls. The built-in [`model-routing-guide` skill](packages/coding-agent/docs/skills.md#model-routing-guide) researches scoped provider/model candidates and local child history, and its `update` mode preserves retained entries while removing stale scope and researching newly added models; the optional global-only [Dispatch Arbiter](packages/coding-agent/docs/agent-models.md#dispatch-arbiter) consumes that guide in a fully headless, tool-less call before every child spawn and may change only agent, scoped canonical model, and supported thinking. Its bounded rolling parent activity follows the title setter and includes useful tool outputs, with existing secret scrubbing applied before inference. It is disabled by default and fails closed—bad configuration, guide, inference, or decisions prevent the child from spawning rather than silently keeping the original route. TUI `/settings` and dashboard Settings expose its enable toggle, exact model, thinking, guide path, and validation/readiness feedback. Typed decisions are persisted and visible in the TUI, JSON/RPC, and dashboard. The same settings surfaces expose `backgroundAgents.maxConcurrentSubagents` (default `4`); `0` starts new parent sessions without the subagent tool and explicitly tells the parent model to perform normally delegated work itself. While background subagents run, a separate guardrail pauses the parent after a few turns, configurable via [`backgroundAgents`](packages/coding-agent/docs/settings.md#background-agents).
- **Durable context.** [Sessions](packages/coding-agent/docs/session.md) are JSONL trees with resume/continue, `/tree` navigation, `/fork`, CLI `--fork`, compaction, HTML export, and JSONL import/export. [Memory](packages/coding-agent/README.md#memory) is file-based, global + project-scoped, survives sessions, can read Claude Code project memory, and can be maintained with `/dream` memory consolidation.
- **A capable terminal workspace.** The TUI supports slash commands, file references with `@`, path completion, image paste/drag, bash shortcuts, hotkeys, settings, model cycling, steering/follow-up queues while the agent is working, token/cost/context status, custom themes, and extension-provided UI surfaces. Transcript prose, code, tool output, and agent results use terminal soft-wrap so copying from scrollback keeps long logical lines intact instead of injecting hard newlines.
- **Optional local companion.** [`/buddy`](packages/coding-agent/docs/buddy.md) hatches an Ollama-powered terminal companion with persistent state, generated personality/backstory, event reactions, idle quips, name-call responses, pet/reroll/stats commands, and a sidebar presence while you work.
- **Codebase and web understanding.** dreb includes file, grep/find/ls, bash, web search/fetch, task tracking, skill invocation, and semantic `search`. Semantic search uses AST-aware chunks, embeddings, POEM ranking, memory indexing, and also ships as [`@dreb/semantic-search`](packages/semantic-search/) with an MCP server for other harnesses. The semantic search package requires Node.js 22+.
- **Detailed usage tracking and performance logging.** dreb records per-session token usage, cost, context-window utilization, and rolling tokens-per-second performance in a local JSONL log (`~/.dreb/agent/performance.jsonl`). This data stays on your machine; the TUI footer, dashboard session details, Telegram `/stats`, and RPC share the same latest-100 median with long-term delta for personal analytics and model comparison.
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

dreb ships with 13 standard built-in tools enabled by default: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `subagent`, `wait`, `watch_github_ci` (blocks until pull-request checks pass or fail), and `ask_user` (pause and ask the user one or more structured multiple-choice or free-text clarifying questions in a single batch wizard, with Markdown-formatted question text and an in-card Stop agent action, rendered natively in the TUI and Dashboard). Setting `backgroundAgents.maxConcurrentSubagents` to `0` removes `subagent` from new parent sessions. Three additional tools are always active: `search` for semantic codebase search, `skill` for loading workflows, and `tasks_update` for visible task tracking. `suggest_next` (ghost text command suggestions, Tab to accept) is active by default but excluded when `--tools` is specified.

Interactive mode adds slash commands such as `/model`, `/settings`, `/resume`, `/tree`, `/fork`, `/compact`, `/dream`, `/buddy`, `/export`, `/reload`, and `/hotkeys`. The message queue lets you steer a running agent or queue follow-up work without waiting for the current turn to finish.

### Provider and model routing

dreb supports both subscription and API-key providers, with model metadata updated in releases. Current provider docs cover subscriptions such as Codex, GitHub Copilot, Gemini CLI, Antigravity, and Kimi; API-key providers such as Anthropic, OpenAI, Azure OpenAI, Google Gemini/Vertex, Amazon Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, ZAI, OpenCode, Hugging Face, Kimi, and MiniMax; plus custom local/proxy providers.

Custom model configuration can override built-in provider base URLs, merge custom models into built-in providers, set compatibility flags for OpenAI-compatible servers, resolve API keys from shell commands or environment variables, select Bearer-only auth for Anthropic-compatible endpoints, and register providers dynamically from extensions.

When switching models, dreb replays exact-model signed, encrypted, or redacted reasoning state unchanged. Portable structured reasoning is limited to models on the same provider using the OpenAI Chat Completions API when the destination accepts the source's recognized plain field (`reasoning_content`, `reasoning`, or `reasoning_text`); other readable reasoning is carried as labelled plaintext, while opaque redacted or encrypted-only state is not sent to incompatible targets. Provider identity and signature compatibility matter for custom models as well. Switching changes only the outbound request, so returning to the original model can replay its original state unless history has been compacted or pruned.

Provider-specific docs include Kimi vision notes that distinguish the Kimi Code OAuth endpoint, the Kimi API-key coding provider, first-party Kimi CLI media handling, and Moonshot Open Platform vision support.

### Workflows and customization

Skills provide progressively loaded instructions for specialized tasks. They can be invoked by users as `/skill:name` or by the model through the `skill` tool, support argument substitution, and can live globally, per-project, in packages, or on the CLI.

Extensions are TypeScript modules loaded with full access to dreb's extension API. They can add or override tools, intercept tool calls, mutate provider payloads, add commands and flags, define custom keyboard shortcuts, render custom tool output, open overlays and custom editors, persist state in sessions, register providers, surface warnings, and implement custom permission or workflow gates.

Resources carry source provenance so commands, tools, skills, and prompts can be traced through autocomplete, RPC discovery, and SDK introspection.

dreb packages make those resources installable and shareable through npm, git, URLs, or local paths. Use `dreb install`, `dreb list`, `dreb update`, and `dreb config` to manage them; project-local packages can be checked into settings so teams get the same skills, extensions, prompts, and themes.

### Sessions, memory, and continuity

Sessions are persistent JSONL files with a tree structure. You can resume recent sessions, browse past sessions, branch in-place with `/tree`, fork sessions into new files, compact long conversations, import/export JSONL, export HTML, or choose a custom session directory.

Memory is just files. Global and project memory indexes are loaded into the system prompt at startup, and entries can store user preferences, good practices, project context, or navigation pointers. `/dream` backs up memory, merges duplicates, scans recent sessions for unrecorded patterns, prunes stale entries, and validates links.

At startup, dreb always loads project context files (`AGENTS.md`/`CLAUDE.md`) by walking **upward** from its launch cwd. This initial upward scan is separate from, and not controlled by, nested-context trust settings. Lazy nested/out-of-cwd loading is **off by default**: when a tool later enters a subdirectory or another repo, its context is loaded only if that canonical directory is covered by a global trusted root in `~/.dreb/agent/settings.json` (`context.trustedFolders`). Trust a root only when you control its instructions; it covers that root and descendants after realpath resolution, so a symlink escaping the root is not trusted. In the dashboard, the Files view is the primary flow to grant or remove folder trust, while Settings lists every configured root for audit/revoke and offers add-by-path. `context.autoLoadNested: true` is a global-only expert trust-all override and can inject prompt-injection content from any resolvable directory. Project `.dreb/settings.json` cannot enable, disable, or extend nested-context trust, so a cloned repository cannot grant itself trust. Main agents and subagents use the same global decision. Auto-loaded content is secret-scrubbed and appended after extension `tool_result` transforms, which intentionally do not see it; paths are deduplicated so each file is injected at most once per session. See [Context Files](packages/coding-agent/README.md#context-files).

### Interfaces and embedding

The same agent runtime powers multiple surfaces:

- **Interactive TUI** — the default terminal coding workspace.
- **Print/headless CLI** — `dreb -p` for one-shot prompts, including piped stdin.
- **JSON mode** — event stream for scripts and automation.
- **RPC mode** — strict [JSONL stdin/stdout protocol](packages/coding-agent/docs/rpc.md) for non-Node clients and custom UIs.
- **SDK** — import `@dreb/coding-agent` and create agent sessions directly in TypeScript.
- **Telegram** — `@dreb/telegram` runs dreb as a bot with sessions, model controls, file upload/download, live tool status, and visible results for user-facing tools.
- **Web dashboard** — `dreb dashboard` serves a browser UI (fleet overview of all sessions, full chat with steering, subagent observability, host file browser, dreb memory editor); local-only by default, remote via Tailscale + rotating pairing code. See [dashboard docs](packages/coding-agent/docs/dashboard.md).

### Web dashboard

The dashboard is the visual face of dreb: every agent session on the host, live in the browser, with the same fidelity as the terminal.

**One host, every screen.** The dashboard server and the TUI share the same sessions on disk and the same agent runtime. Start a refactor in the terminal, open the dashboard on your desktop to watch its subagents fan out, then pick the same session up from your phone on the couch — one synchronized state everywhere, streaming live over SSE. The layout is responsive by design: on a desktop it's a dense multi-column fleet; on a phone, fleet cards stack and their content wraps instead of overflowing, while the session view prioritizes read-and-steer because steering a running agent from wherever you are is the point.

<!-- screenshot: fleet overview, desktop (light) -->
<!-- screenshot: session view, mobile -->

**Fleet overview.** Home base is every session across every project: live sessions with status chips (running / needs-attention / idle / error), activity lines, running subagents, task progress, context usage, and model — plus past sessions grouped by project, resumable with one tap. Terminal provider/API failures show their reason on the fleet card; transient failures clear that terminal card state when automatic retry begins. Live cards update through compact SSE snapshots instead of re-fetching the full cross-project inventory on every turn, keeping weak mobile links responsive. When a session needs input, the browser tab badges and (opt-in) sends a service-worker notification (installable PWA, works on Android and iOS). For opt-in local mobile transport profiling, see the [dashboard docs](packages/coding-agent/docs/dashboard.md#mobile-transport-profiling).

**Full-parity session view.** Not a reduced chat client: streaming markdown, thinking blocks, bespoke tool cards (read/write/edit/bash and markdown-rendering tools), sanitized inline PNG/JPEG/GIF/WebP images returned by any tool, task panels, queued-message chips, image attach/paste with sent-image transcript previews, built-in slash-command autocomplete and execution (including model/settings, scoped-models, session tree, fork, compact, import/export, dream, resume/reload, and new/quit), model/thinking switchers, fork-from-message, HTML export. `/scoped-models` opens the Settings editor for the session's current project context. Built-ins are intercepted generically and rejected fail-closed at the RPC prompt boundary, so unsupported or future commands show guidance instead of leaking into model input. Provider/API failures render inline on the failed assistant attempt with any partial output preserved, including after refresh or recovery; transient failures then switch the session status to retrying without erasing that history. Tool-result images remain visible to the human even when the active model is text-only. While the agent works you can **steer** (inject into the running turn), **queue follow-ups**, or **stop** — the same queue semantics as the TUI.

**Notifications without surprise navigation.** Session-scoped notices, warnings, and errors share one dismissible banner region at the top of the transcript, with long mobile messages scrolling beneath controls that remain reachable; app-global and other-session notices use a fixed top-center stack. Starting or closing a runtime never moves the browser automatically. A closed main-session or subagent page keeps its already-rendered transcript as a read-only browser snapshot with explicit Resume and Return-to-fleet actions until the user leaves, while Fleet simply removes the live card and keeps the on-disk session resumable in its project group.

**Scoped models.** Dashboard Settings includes an editor for the persistent model-cycling scope. It searches provider-grouped available models; offers model, provider, and all-model toggles; shows accessible up/down controls for the ordered partial scope; and has save/reset actions that work on mobile. An absent `enabledModels` value means implicit all models in registry order, including future registry additions, and that all-model view cannot be reordered. A saved partial scope is a non-empty ordered list of exact canonical `provider/model` references; editing a legacy glob, fuzzy, or thinking-suffix scope normalizes it to that form. The selected project context reads effective global plus project settings, but dashboard writes remain global and warn when a project value shadows the result. Changes seed new sessions only and never mutate running sessions. See [Settings](packages/coding-agent/docs/settings.md#model-cycling) and the [RPC settings contract](packages/coding-agent/docs/rpc.md#settings).

**Low-data transcript images.** Tool results and images uploaded with user turns remain visible through content-addressed browser references rather than full base64 in events and transcript JSON. The default browser-local mode lazily requests a preview bounded to 1024 × 1024 and 256 KiB; clicking enlarges that same preview without downloading the original. Settings also offers request-free placeholders and informed-opt-in automatic originals. Explicit originals disclose their size and confirm above 1 MiB. Authenticated same-origin routes accept only signature-matching PNG/JPEG/GIF/WebP, send `nosniff`, and recover evicted entries from authoritative session data; static GIF previews preserve animated originals behind the original route. Image bytes therefore cannot cause an SSE oversized-event resync. Full-resolution HTML exports remain self-contained and unchanged.

<!-- screenshot: session view with tool cards + subagent panel, desktop (dark) -->

**Live subagent observability and steering.** Background subagents are first-class: the parent session has a bounded, scrollable panel listing every retained agent newest-first with full running/done counts, fleet cards show live counts, and each agent has a drill-in transcript that streams in real time and survives browser reloads. While a child is running, that view can queue the user's own steering messages directly to that child, showing its pending queue and effective one-at-a-time or all-at-once delivery mode; completed history remains read-only. The panel uses the task tracker's native collapse pattern and starts collapsed on mobile. When the Dispatch Arbiter is enabled, those views also show its host-validated changed, unchanged, or failed pre-spawn decision and the final routed agent/model/thinking—never raw arbiter output.

**Live connection recovery.** The top bar and persistent session header have an accessible, text-labelled connection indicator (connecting, connected, retrying, resyncing, disconnected, or auth failed). SSE uses bounded replay and an authoritative snapshot barrier to recover from browser reloads, server restarts, sequence gaps, slow-client backpressure, and stalls without duplicating state; task lists restore with the session snapshot. Named 25-second heartbeats and a foreground 60-second liveness watchdog detect a stuck stream. See [dashboard recovery details](packages/coding-agent/docs/dashboard.md#live-connection-and-recovery) and the [RPC ordering contract](packages/coding-agent/docs/rpc.md#get_dashboard_snapshot).

**Host files, explicitly.** Browse the host filesystem, upload/download, create folders, and start a new session in any directory — every file operation logged server-side.

**Memories, repairable.** The Memories screen edits dreb memory scopes only: global `~/.dreb/memory` plus populated `.dreb/memory` directories for active/disk project roots (empty projects are omitted because entry creation is outside this screen). It shows the complete `MEMORY.md` index (with a warning when it exceeds the 200-line prompt convention), opens local index links in the current scope, provides visible loading feedback, displays existing entry metadata or parse errors and sanitized Markdown previews, preserves drafts on exact-revision conflicts, and synchronously cleans matching index links before deleting an entry. It does not create/rename entries or expose Claude memory paths.

**Curated appearance themes.** A theme gallery in settings offers eight dashboard-native themes (entropist.ca, Dim, Solarized, Gruvbox, Caves of Qud, Van Gogh, plus the colorblind-safe Okabe-Ito and Paul Tol palettes), each with its own light and dark palette, plus a system/light/dark mode toggle. Choices are saved per browser and are independent of your TUI theme.

Launch locally:

```bash
dreb dashboard
# or: dreb-dashboard
```

**Remote access is explicit and Tailscale-only.** There is no LAN mode and no public exposure. Local mode binds loopback exclusively (with Host/Origin validation against DNS rebinding). Remote mode requires [Tailscale](https://tailscale.com) — from your phone on the same WiFi or from the other side of the world, the path is identical:

```bash
dreb-dashboard --remote --allow you@example.com
```

Every remote request passes fail-closed layers: peer-specific tailnet identity resolution (concurrent requests for one peer share the in-flight lookup), identity allowlist (empty list denies everyone), first-login pairing with a rotating 6-digit code shown only on the host, then a signed device cookie. New pairings last 180 days by default; Settings can choose 1–3650 days for future pairings without changing existing expiry dates. A remote device in the final 10% of its recorded lifetime gets an advance warning at most once per UTC day. Paired devices and their expiry dates are listed in settings and can be unpaired at any time. Pairing grants terminal-equivalent power — the pairing screen says so before the code is entered.

**Installable PWA + mobile notifications.** The dashboard is an installable web app — add it to the home screen on Android Chrome or iOS Safari 16.4+ for a standalone, no-URL-bar experience. Needs-attention notifications go through the service worker (`registration.showNotification`) — the only path that works on Android (which removed the page Notification constructor) and on iOS (installed PWA only). For remote access from a phone, notifications and the service worker require a **secure context** (HTTPS), so the dashboard can terminate TLS itself using `tailscale cert` files — no reverse proxy, and the auth model is unchanged (the peer address stays the real tailnet IP):

```bash
dreb-dashboard --remote --allow you@example.com \
  --https --cert /etc/dreb/cert.pem --key /etc/dreb/key.pem
```

Local mode (`http://127.0.0.1`) already qualifies as a secure context, so install and notifications work there with no TLS setup. See the [dashboard docs](packages/coding-agent/docs/dashboard.md) for the one-time `tailscale cert` setup and renewal walkthrough.

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

For auto-restart on macOS, create a LaunchAgent. Launchd runs with a minimal `PATH`, so invoke `node` directly on the resolved entry point (use `command -v node` and `realpath "$(command -v dreb-dashboard)"` — paths vary by install method; if `realpath` is not found, `brew install coreutils`):

Save as `~/Library/LaunchAgents/com.dreb.dashboard.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dreb.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/ABSOLUTE/PATH/TO/node</string>
        <string>/ABSOLUTE/PATH/TO/@dreb/dashboard/dist/index.js</string>
        <string>--port</string>
        <string>5343</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/YOU/Library/Logs/dreb-dashboard.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/Library/Logs/dreb-dashboard.err.log</string>
</dict>
</plist>
```

```bash
# load / start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dreb.dashboard.plist
# stop / unload
launchctl bootout gui/$(id -u)/com.dreb.dashboard
# check status
launchctl print gui/$(id -u)/com.dreb.dashboard | grep -E 'state|pid'
```

> This is a **LaunchAgent** (must run as your user to read `~/.dreb/agent` and spawn RPC children as you), not a LaunchDaemon. OAuth subscription creds in `~/.dreb/agent/auth.json` are found automatically via `HOME`. If you use API keys via shell environment variables, add them to `EnvironmentVariables` — LaunchAgents do not source shell profiles. See the [dashboard docs](packages/coding-agent/docs/dashboard.md#background-service--auto-restart) for full details.

**WSL2 users:** if you reach the dashboard from a Windows browser and hit an intermittent access-denied / pairing screen on `http://127.0.0.1` after the WSL VM has been idle, see the [WSL2 gotcha](packages/coding-agent/docs/dashboard.md#wsl2-gotcha) for the cause and keep-alive workarounds.

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
