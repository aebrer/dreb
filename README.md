# dreb

A provider-agnostic agentic coding harness. Use any LLM backend — coding subscriptions, cloud APIs, local models — without locking into a single provider or interface.

Hard fork of [pi-mono](https://github.com/badlogic/pi-mono) (MIT). See [FORK.md](FORK.md) for details.

## Quick start

```bash
# Clone and build
git clone https://github.com/aebrer/dreb.git
cd dreb && npm install && npm run build

# Set a provider key
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, etc.

# Run
node packages/coding-agent/dist/cli.js
```

Or authenticate with a coding subscription (Claude Max, Codex, GitHub Copilot):

```bash
dreb
/login
```

## What it does

dreb gives an LLM a set of tools — read, write, edit, bash, grep, find, glob, web search/fetch, subagents — and lets it use them to fulfill your requests. The harness handles the tool loop, streaming, context management, and session persistence. You bring the model.

**15+ LLM providers** supported out of the box: Anthropic, OpenAI, Google, Mistral, Bedrock, OpenRouter, and more. OAuth support for coding subscriptions. Local models via any OpenAI-compatible endpoint (ollama, vllm).

**Modes**: Interactive TUI, CLI, RPC (for process integration), SDK (for embedding in your own apps).

## Why fork?

A coding harness has access to your filesystem, shell, and auth tokens — it's the highest-trust software you run. A hard fork means no `npm install` pulling in upstream changes you haven't audited. We maintain independently and cherry-pick from upstream when something useful lands, after reading the diff.

See the [brainstorming doc](docs/brainstorming.md) for the full rationale.

## Packages

| Package | Description |
|---|---|
| [@dreb/ai](packages/ai/) | LLM provider abstraction — 15+ adapters, OAuth, model discovery |
| [@dreb/agent-core](packages/agent/) | Agent runtime — tool loop, state, streaming, hooks |
| [@dreb/coding-agent](packages/coding-agent/) | CLI tool, built-in tools, sessions, extensions |
| [@dreb/tui](packages/tui/) | Terminal UI — differential rendering, markdown, syntax highlighting |

## License

MIT
