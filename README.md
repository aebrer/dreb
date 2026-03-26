# dreb

A provider-agnostic agentic coding harness. Use any LLM backend — coding subscriptions, self-hosted models, local inference — through a unified tool-use interface.

**Status**: Early brainstorming. Not yet functional.

## Goals

- **Provider agnostic** — Anthropic, OpenAI, Google, z.ai, OpenRouter, ollama, vllm, whatever. Bring your own backend.
- **Subscription friendly** — Work with coding subscriptions (Claude Code, Codex, etc.), not just raw API keys.
- **Minimal core** — Small, auditable tool-use loop. No bloat.
- **Multiple frontends** — CLI, Telegram, web, whatever. The harness is a library, not an app.
- **Local-first** — Runs on your machine, your models, your rules.

## Architecture (planned)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  Frontends   │     │    Core      │     │  Providers    │
│  - CLI       │────▶│  - Tool loop │────▶│  - Anthropic  │
│  - Telegram  │     │  - Tools     │     │  - OpenAI     │
│  - Web       │     │  - Context   │     │  - Google     │
│  - API       │     │  - Memory    │     │  - z.ai       │
└─────────────┘     └─────────────┘     │  - ollama     │
                                         │  - vllm       │
                                         └──────────────┘
```

## License

MIT
