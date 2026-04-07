# dreb

An open-source terminal coding agent, forked from [pi-mono](https://github.com/badlogic/pi-mono) (itself derived from Claude Code). It has *fewer* features than Claude Code by design — the bet is that a small, hackable core you can shape beats a large feature set you can't.

Claude Code is a great product. dreb isn't trying to compete on features — it's trying to compete on flexibility. The core is kept minimal; what you'd find baked into other tools, you build here with skills (markdown workflows), extensions (TypeScript), or install from third-party packages.

Concretely, dreb ships *without* things Claude Code has — and that's intentional:

- **No MCP.** Build CLI tools with READMEs (Skills), or build an extension that adds MCP support.
- **No permission popups.** Run in a container, or build your own confirmation flow with extensions.
- **No plan mode.** Write plans to files, or build it with extensions, or install a package.
- **No background bash in the main agent.** The main agent runs commands synchronously. For parallel work, use the subagent tool.

What you get in exchange: a skill system, an extension API, custom agent definitions, custom provider support (route through any proxy, use any API-compatible backend), and a subagent system for parallel work. From those primitives, you build what you need.

## Quick Start

```bash
git clone https://github.com/aebrer/dreb.git
cd dreb
npm install
npm run build
npm link -w packages/coding-agent
```

Then authenticate and run:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
dreb
```

Or use a coding subscription (Codex, GitHub Copilot): run `dreb` then `/login`.

Or use a custom provider — corporate proxy, Bedrock, local models, anything OpenAI/Anthropic-compatible. See [Custom Models](packages/coding-agent/docs/models.md).

## What's In It

**10 built-in tools:** `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `subagent` — plus always-active `search`, `skill`, and `tasks_update`.

**[mach6](packages/coding-agent/docs/mach6.md)** — a built-in development workflow covering the full issue-to-merge lifecycle: assess → plan → implement → push → review → fix → publish. Multi-agent code review with 5 specialized agents running in parallel, independent assessment of findings, iterative review-fix cycles, GitHub as shared memory. Inspired by [mach10](https://github.com/LeanAndMean/mach10) by Kevin Ryan.

**[Skills](packages/coding-agent/docs/skills.md)** — markdown workflow definitions the agent loads on-demand. Built-in skills ship with dreb; add your own or install third-party ones.

**[Extensions](packages/coding-agent/docs/extensions.md)** — TypeScript modules for custom tools, commands, keyboard shortcuts, event handlers, UI components, custom providers.

**[Sessions](packages/coding-agent/README.md#sessions)** — persistent session tree with branching, compaction, and in-place navigation.

**[Memory](packages/coding-agent/README.md#memory)** — persistent, file-based memory (global + project-scoped) that survives across sessions.

**[Custom Providers](packages/coding-agent/docs/models.md)** — route any built-in provider through a proxy, add new providers via JSON config or extensions. 20+ providers supported out of the box.

**Modes:** Interactive TUI, print/JSON CLI, RPC (for process integration), SDK (for embedding in your own apps).

## Why Fork?

A hard fork means we control the update cadence. No upstream changes land without us reading the diff first. We cherry-pick what's useful and skip what isn't.

See [FORK.md](FORK.md) for details.

## Packages

| Package | Description |
|---|---|
| [packages/coding-agent](packages/coding-agent/) | CLI tool, built-in tools, skills, sessions, extensions — [full docs](packages/coding-agent/README.md) |
| [packages/ai](packages/ai/) | LLM provider abstraction — 20+ adapters, OAuth, model discovery |
| [packages/agent](packages/agent/) | Agent runtime — tool loop, state, streaming, hooks |
| [packages/tui](packages/tui/) | Terminal UI — differential rendering, markdown, syntax highlighting |

## License

MIT
