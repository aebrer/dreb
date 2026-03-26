# Feature Spec: Tool Parity

What dreb needs to support, informed by actual Claude Code usage data (243 main sessions, 464 subagent sessions) and gap analysis against pi-mono's current capabilities.

## What pi-mono already covers

These tools/features exist in pi-mono and require minimal work beyond the fork:

| Tool | Our Usage | Pi-mono |
|------|-----------|---------|
| **Bash** | 1,770 calls, #1 tool (36%) | `bash` — core tool |
| **Read** | 880 calls, #3 tool | `read` — core tool |
| **Edit** | 1,031 calls, #2 tool | `edit` — core tool, includes conflict handling |
| **Write** | 143 calls | `write` — core tool |
| **Grep** | 213 calls | `grep` — available, disabled by default (enable it) |
| **Find/Glob** | 51 main + 298 subagent | `find` + `ls` — available, disabled by default. Needs glob wrapper (see below). |

**Also covered:** parallel tool execution, session persistence (JSONL with branching), context compaction, provider adapters (18+), extension system, CLI/RPC/SDK frontends.

## Gaps to fill

Ordered by impact, based on usage data and workflow criticality.

---

### P0: Must have before usable

#### 1. Subagent orchestration

**The gap:** Pi-mono deliberately excludes subagents. Our data shows 87 spawns across 19 sessions (7.8%), but those sessions average 4.6 spawns each and use typed agents (Explore, code-reviewer, silent-failure-hunter, etc.). This is how we parallelize research and review.

**What we need:**
- Ability to spawn child agent sessions from the main session
- Each subagent gets its own context window and tool access
- Parent can define the subagent's role/constraints (read-only, specific tools, custom system prompt)
- Results flow back to parent session
- Typed agent presets: at minimum `general-purpose` and `Explore` (cover 75% of our spawns)

**Implementation direction:** The RPC/SDK mode already lets you create agent sessions programmatically. A subagent is essentially: spawn a new session via SDK, inject a system prompt, collect the result, return it to the parent. The extension system could host this, but it's core enough that it should be in the harness.

**Key workflow:** Main session delegates research/review to subagents → subagents return findings → main session acts on them. The parent never blocks on a subagent (fire-and-forget with notification on completion).

See [spec-subagents.md](spec-subagents.md) for full specification.

#### 2. WebSearch + WebFetch

**The gap:** Pi-mono has no web access tools. We use WebSearch in 17.7% of main sessions (247 calls) and WebFetch in 11.5% (131 calls). Subagents use them even more heavily (463 + 456 calls). The WebSearch→WebFetch chain is our primary research workflow.

**What we need:**
- `web_search` tool: takes a query, returns structured results (title, URL, snippet)
- `web_fetch` tool: takes a URL, returns page content (text extraction, not raw HTML)
- Both usable in main and subagent sessions

**Implementation direction:** These are straightforward extension tools. Search via a provider (SearXNG self-hosted, Brave Search API, or similar). Fetch via headless browser or trafilatura-style text extraction. Keep provider-agnostic — the search backend should be configurable.

See [spec-web-tools.md](spec-web-tools.md) for full specification.

#### 3. Telegram frontend

**The gap:** 91% of our sessions are via Telegram. Pi-mono has Slack (`pi-mom`) which provides the architectural pattern, but no Telegram equivalent.

**What we need:**
- Telegram bot that talks to dreb's RPC mode
- Message queueing (Telegram messages arrive while agent is processing)
- File upload/download support
- Inline tool progress (or at minimum, a "working..." indicator)
- Session management (/sessions, /resume, /stop)

**Implementation direction:** Carcin already does this for Claude Code. Post-fork, Carcin becomes a thin Telegram client that speaks dreb's RPC protocol instead of Claude Code's. The RPC mode (stdin/stdout JSONL) is the integration point.

---

### P1: Important for workflow completeness

#### 4. Memory system

**The gap:** Pi-mono uses `AGENTS.md` / `.pi/SYSTEM.md` for project context but has no persistent cross-session memory with structured types (user, feedback, project, reference).

**What we need:**
- File-based memory store (markdown files with frontmatter, like our current system)
- Memory types: user preferences, feedback/corrections, project context, external references
- Auto-loaded into context at session start (via MEMORY.md index)
- Read/write from within sessions
- Scoped: global (`~/.dreb/memory/`) and per-project (`.dreb/memory/`)

**Implementation direction:** Extension that hooks into `session_start` to inject memory context, and registers `memory_write`/`memory_read` tools. The memory format is just markdown files — the "system" is really a convention plus a tool to manage it.

See [spec-memory.md](spec-memory.md) for full specification.

#### 5. Skills system

**The gap:** Pi-mono has "skills" as npm packages following an Agent Skills standard. Our system uses symlinked markdown files (`~/.claude/skills/`) with SKILL.md defining the trigger conditions and behavior. 42 invocations across 11 skills in our data.

**What we need:**
- Skill discovery from `~/.dreb/skills/` and `.dreb/skills/`
- SKILL.md format: name, description, trigger conditions, prompt template
- Skill invocation as a tool (user says `/skillname`, agent calls Skill tool)
- Skills can define which tools they need and what subagents to spawn

**Implementation direction:** This maps well to pi-mono's extension + slash command system. A skill is: a slash command that injects a prompt template. The extension API already supports custom slash commands. Main work is the discovery/loading convention and the SKILL.md format parser.

See [spec-skills.md](spec-skills.md) for full specification.

#### 6. Task/progress tracking

**The gap:** TodoWrite has 356 total calls (193 main + 163 subagent). Pi-mono has no built-in task tracking.

**What we need:**
- A way for the agent to create and update a visible task list during execution
- Rendered in whatever frontend is active (TUI shows inline, Telegram sends as formatted message)
- Simple: create task, update status (pending/in-progress/done), that's it

**Implementation direction:** Extension tool that writes to a session-local task list. Frontend renders it. TodoWrite's heavy usage suggests this is genuinely useful for tracking multi-step work, not just Claude Code overhead.

See [spec-tasks.md](spec-tasks.md) for full specification.

#### 7. Glob (pattern-based file search)

**The gap:** Pi-mono has `find` but not glob-pattern matching. 51 main + 298 subagent calls.

See [spec-glob.md](spec-glob.md) for full specification.

#### 8. ToolSearch (dynamic tool discovery)

**The gap:** 98 calls in main sessions. This is the mechanism for lazy-loading tool schemas so the full set doesn't bloat context.

See [spec-tool-search.md](spec-tool-search.md) for full specification.

#### 9. Context file loading (CLAUDE.md + AGENTS.md)

**The gap:** Pi-mono reads `AGENTS.md` and `.pi/SYSTEM.md`. We have `CLAUDE.md` everywhere. Dreb should read both.

See [spec-context-files.md](spec-context-files.md) for full specification.

---

## What we explicitly skip

Based on usage data showing zero or negligible adoption:

- **EnterPlanMode / ExitPlanMode** — 2+3 calls, and plan mode hangs in Telegram. Skip entirely.
- **AskUserQuestion** — 3 calls total. The user is already talking to us.
- **CronCreate / CronList** — 1+1 calls. Scheduling belongs outside the harness.
- **NotebookEdit** — 0 calls. No Jupyter usage.

## Tool transition patterns worth preserving

Our data shows clear workflow loops that the harness should optimize for:

1. **Read → Edit → Bash** (understand → modify → test) — 346+215 transitions. The core coding loop.
2. **Bash → Bash → Bash** (1,208 self-transitions) — Sequential command execution. Ensure Bash tool doesn't add unnecessary overhead between calls.
3. **WebSearch → WebFetch** (146+57 transitions) — Research flow. These should share context (search results inform which URLs to fetch).
4. **Grep → Read → Edit** (77+52 transitions) — Search → understand → modify. Grep results should make it easy to jump into Read.
5. **Agent → Agent** (in subagent data) — Recursive spawning. Support but with depth limits.

## Open questions

- **Glob vs find:** Do we implement glob as a separate tool or enhance pi-mono's existing `find` with glob patterns?
- **Subagent depth:** How deep should recursive spawning go? Our data shows it happens but doesn't quantify depth.
- **Skill format:** Adopt pi-mono's npm-package skills alongside our SKILL.md format, or replace entirely?
- **Memory injection:** Load all memory at session start (current approach) or lazy-load on relevance?
