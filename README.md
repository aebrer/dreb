# dreb

A provider-agnostic agentic coding harness. Build your own coding assistant that works with any LLM backend — coding subscriptions, self-hosted models, local inference — and isn't locked into any single provider or interface.

**Status**: Early brainstorming. Not yet functional.

## Motivation

Agentic coding tools like Claude Code and Codex are great, but they lock you into a single provider. If pricing changes, a service goes down, or a better model comes along, you're stuck. dreb is a harness that separates the tool-use engine from the LLM backend, so you can swap providers without rebuilding your workflow.

## Goals

- **Provider agnostic** — Support coding subscriptions (Claude Max, Codex, etc.), cloud APIs (OpenRouter, z.ai, Google, etc.), and local/self-hosted models (ollama, vllm). No dependence on any single provider's API.
- **Library, not an app** — The harness exposes its own API. Frontends (CLI, Telegram, web, whatever) are thin clients. This means existing projects like [Carcin](https://github.com/aebrer/carcin) can become test surfaces that validate the API is solid.
- **Only the features we need** — Analyze actual usage patterns from existing session files to figure out which tools and features matter, then build those. No bloat.
- **Learn from existing tools** — Claude Code is proprietary (not open source despite being on GitHub), but we can study its patterns. Other actually-open-source harnesses (aider, etc.) exist to learn from and borrow code where licenses allow.
- **Eventually local** — Local model support via ollama/vllm (which expose OpenAI-compatible endpoints) should fall out naturally from provider abstraction.

## Planned approach

1. **Analyze** — Mine Claude Code session files on disk to understand actual tool usage distribution, context lengths, and which features get used vs. ignored.
2. **Direct backend** — Replace shelling out to a CLI with direct communication to an LLM backend + our own tool executor.
3. **Provider abstraction** — Thin adapter layer so backends can be swapped. Tool-use schemas are ~90% compatible across providers already.
4. **Local model support** — ollama/vllm expose OpenAI-compatible endpoints, so this mostly falls out of step 3.

## License

MIT
