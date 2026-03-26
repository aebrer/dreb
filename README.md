# dreb

A provider-agnostic agentic coding harness. Build your own coding assistant that works with any LLM backend — coding subscriptions, self-hosted models, local inference — and isn't locked into any single provider or interface.

**Status**: Early brainstorming. Not yet functional.

## Motivation

Agentic coding tools like Claude Code and Codex are great, but they lock you into a single provider. If pricing changes, a service goes down, or a better model comes along, you're stuck. dreb is a harness that separates the tool-use engine from the LLM backend, so you can swap providers without rebuilding your workflow.

## Goals

- **Provider agnostic** — Support coding subscriptions (Claude Max, Codex, etc.), cloud APIs (OpenRouter, z.ai, Google, etc.), and local/self-hosted models (ollama, vllm). No dependence on any single provider's API.
- **Library, not an app** — The harness exposes its own API. Frontends (CLI, Telegram, web, whatever) are thin clients. This means existing projects like [Carcin](https://github.com/aebrer/carcin) can become test surfaces that validate the API is solid.
- **Only the features we need** — Analyze actual usage patterns from existing session files to figure out which tools and features matter, then build those. No bloat.
- **Own the stack** — Hard fork of [pi-mono](https://github.com/badlogic/pi-mono) (MIT) as the foundation, then strip to what we need and maintain independently. No upstream dependency means no supply chain risk — we control every line of code that runs.
- **Eventually local** — Local model support via ollama/vllm (which expose OpenAI-compatible endpoints) should fall out naturally from provider abstraction.

## Foundation

dreb is a hard fork of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner (MIT licensed). pi-mono already solves most of the hard problems:

- 15+ LLM provider adapters with OAuth for coding subscriptions (Claude Max, Codex, GitHub Copilot, etc.)
- Core tool loop with parallel execution, streaming, context management
- Extension system for custom tools/commands without touching core
- Multiple frontend modes (CLI, RPC, SDK, web, Slack)
- Session persistence with branching

Rather than reinvent all of this, we fork at a known-good point and maintain independently. Cherry-pick from upstream when something useful lands, after reading the diff.

### Why fork instead of depend?

Supply chain security. A coding harness has access to your filesystem, shell, and auth tokens — it's about the highest-trust software you run. The [litellm supply chain attack](https://docs.litellm.ai/blog/security-update-march-2026) (March 2026) showed that even widely-used open source tooling can be compromised through maintainer credential theft. A hard fork means:

- No `npm install` pulling in upstream changes you haven't audited
- An attacker would need to target this repo specifically
- Dependencies can be vendored and trimmed to reduce surface area
- Moving slowly (weeks behind upstream at most) is a feature, not a sacrifice

## Planned approach

1. **Analyze** — Mine Claude Code session files on disk to understand actual tool usage distribution, context lengths, and which features get used vs. ignored.
2. **Fork and strip** — Hard fork pi-mono, remove what we don't need, vendor key dependencies, audit what remains.
3. **Customize** — Add our own memory/skills system, Telegram frontend (via Carcin), and any dreb-specific opinions.
4. **Maintain** — Occasionally cherry-pick from upstream pi-mono when worthwhile, after reading the diff.

## License

MIT
