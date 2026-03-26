# Brainstorming

## Origin

This came out of a conversation about long-term sustainability — making sure we can keep our agentic coding workflow going regardless of what happens with any single provider. The core tool-use loop is simpler than people think. The hard parts are in the polish.

## Difficulty breakdown

### Easy (days)
- **Core tool loop**: send messages with tool definitions → model returns tool calls → execute → feed results back → repeat
- **Basic tools**: file read/write/edit, shell exec, glob, grep — straightforward to implement
- **Provider adapter skeleton**: thin interface, `send_message(messages, tools) -> response`

### Medium (weeks)
- **Context window management** — compression, summarization, smart truncation when hitting limits
- **Permission system** — sandboxing, approval flows
- **Streaming + cancellation** — responsive UX, especially important over Telegram
- **Memory/skills/project instructions** — equivalent of CLAUDE.md loading and memory system

### Hard
- **Edit tool quality** — diff-based editing with fuzzy matching and conflict resolution. Naive string replacement breaks constantly. Can steal from Claude Code (MIT).
- **Prompt engineering per provider** — the system prompt that makes a model good at coding is a huge amount of accumulated tuning. Different per provider.
- **Subscription/session auth** — each coding subscription (Claude Max, Codex, etc.) has its own auth flow. OAuth where available, but not all providers support it yet.

## Architecture

The harness is a library. It exposes its own API. Frontends are thin clients.

This means Carcin (Telegram bot) becomes a frontend client of dreb, not the engine itself. Having Carcin as a test surface ensures our own API is solid — if it works well over Telegram, it'll work well anywhere.

Other potential frontends: CLI, web UI, API server for other integrations.

## Provider abstraction

The key interface is simple:

```
Provider.send_message(messages, tools) -> response
```

Each provider adapter handles:
- Auth (API key, OAuth, session token — whatever the provider uses)
- Message format translation (minor differences)
- Tool schema translation (mostly compatible across providers)
- Streaming

Provider categories:
- **Coding subscriptions**: Claude Max, Codex, etc. — use existing subscription auth (OAuth where supported)
- **Cloud APIs**: OpenRouter, z.ai, Google, etc. — API keys
- **Local/self-hosted**: ollama, vllm — OpenAI-compatible endpoints, no auth needed

Note: The goal is to use existing coding subscriptions (which you're already paying for) rather than paying separately for raw API access. Providers are interchangeable — that's the whole point.

## First step: analyze what we actually use

Before building anything, mine Claude Code session files (`~/.claude/`) to understand:
- Which tools get used and how often
- Average context window usage and how often compression kicks in
- Which "features" (skills, memory, subagents, etc.) actually get used vs. exist but are ignored
- Typical session lengths and patterns

This tells us what 20% of features cover 80% of usage.

## What we can steal

- **Claude Code** (MIT) — tool implementations, especially Edit with fuzzy matching
- **Other open source harnesses** — pi.ai, aider, etc.
- **Session file data** — our own usage patterns

## Open questions

- What's the Claude Code session file format? How much can we extract?
- How do coding subscriptions actually auth? OAuth? Session cookies?
- Can we start with a naive Edit tool and iterate, or is fuzzy matching table stakes?
- Context compression: roll our own summarizer or use the model itself?
- Permission system: needed from day one or add later?
- Memory/skills: port the existing system or design something better?
