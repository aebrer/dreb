# Brainstorming

## Origin

This came out of a conversation about long-term sustainability — making sure we can keep our agentic coding workflow going regardless of what happens with any single provider. The core tool-use loop is simpler than people think. The hard parts are in the polish.

## Why pi-mono as a foundation

After evaluating build-from-scratch vs. fork, the fork wins on pure pragmatism:

- **15+ provider adapters already written** — including OAuth flows for coding subscriptions (Claude Max, Codex, GitHub Copilot, Gemini CLI). Writing these from scratch is weeks of tedious work.
- **Core tool loop is solid** — parallel tool execution, streaming, context management, session persistence with branching.
- **Extension system** — custom tools, providers, and commands can be added without modifying core code. Most of what makes our workflow *ours* (memory, skills, specific tools) can live in extensions.
- **Multiple frontend modes** — CLI, RPC (stdin/stdout protocol), SDK, web UI, Slack bot. The RPC mode is exactly how Carcin could talk to the harness.
- **MIT licensed** — no restrictions on forking, modifying, or distributing.
- **Clean TypeScript codebase** — modular packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `pi-web-ui`, `pi-mom`), each independently useful.

### What pi-mono gives us for free

| Problem | pi-mono solution |
|---------|-----------------|
| Provider OAuth | Built-in for Claude Max, Codex, Copilot, Gemini CLI, etc. |
| Tool execution | Parallel + sequential, streaming progress, before/after hooks |
| Edit tool | Already implemented with conflict handling |
| Context management | Compaction (manual + auto on overflow), JSONL session persistence |
| Multiple frontends | CLI, RPC, SDK, web components, Slack |
| Extensibility | Extensions discover from `~/.pi/` and `.pi/`, no fork needed for most customization |

### What we still need to build

- **Memory system** — pi uses `AGENTS.md`/`.pi/SYSTEM.md` but doesn't have persistent cross-session memory like our current setup
- **Skills system** — pi has skills but the pattern differs from ours
- **Telegram frontend** — pi has Slack (`pi-mom`), so the pattern exists to follow for a Telegram equivalent
- **Dependency audit and vendoring** — trim the dep tree, vendor what we keep
- **Our own opinions** — prompt tuning, default behaviors, UX preferences

## Supply chain rationale

A coding harness has access to your filesystem, shell, and auth tokens. It's the highest-trust software you run besides your OS. The [litellm incident](https://docs.litellm.ai/blog/security-update-march-2026) (March 2026 — compromised PyPI maintainer creds via a poisoned security scanner in CI/CD, malicious `.pth` file exfiltrating credentials, 3.4M downloads/day affected) demonstrates that "widely used open source" is a bigger target, not a security guarantee.

Hard fork means:
- Snapshot at a known-good commit, it's ours from that point
- No `npm install` / `npm update` pulling in unaudited changes
- An attacker has to compromise *our* repo specifically (hopefully not worth targeting)
- Dependencies can be vendored and trimmed
- Moving a few weeks behind upstream is not a sacrifice — it's the cost of confidence

## Architecture (inherited from pi-mono, to be customized)

```
pi-mono packages (renamed/forked as dreb):

┌─────────────┐
│   pi-ai      │  LLM abstraction — provider adapters, auth, streaming
└──────┬───────┘
       │
┌──────▼───────┐
│ pi-agent-core │  Tool loop, execution, events, session persistence
└──────┬───────┘
       │
┌──────▼───────┐     ┌──────────────┐     ┌──────────────┐
│ pi-coding-   │     │   pi-mom      │     │  dreb-tg     │
│ agent (CLI)  │     │  (Slack bot)  │     │  (Telegram)  │
└──────────────┘     └──────────────┘     └──────────────┘
                                           ▲
                                           │ Carcin becomes
                                           │ a frontend client
```

## First step: analyze what we actually use

Before forking and stripping, mine Claude Code session files (`~/.claude/`) to understand:
- Which tools get used and how often
- Average context window usage and how often compression kicks in
- Which "features" (skills, memory, subagents, etc.) actually get used vs. exist but are ignored
- Typical session lengths and patterns

This tells us what 20% of features cover 80% of usage, and informs what to keep vs. strip from the fork.

## What we can also learn from

- **Claude Code** — proprietary (all rights reserved), but we can read the public repo to generate spec and inform our own implementations
- **Session file data** — our own usage patterns are ours to mine

## Open questions

- What's the Claude Code session file format? How much can we extract?
- pi-mono is TypeScript — are we comfortable maintaining that long-term, or do we want to eventually port critical pieces to Python?
- Which pi-mono packages do we actually need? Can we drop `pi-pods`, `pi-mom`, `pi-web-ui` immediately?
- How much of pi-mono's dep tree can we vendor vs. trim?
- Memory/skills: port our existing system as a pi extension, or redesign?
- Renaming: do we rename the packages (e.g. `@dreb/ai`, `@dreb/agent`) or keep internal names and just rebrand the CLI?
