# Brainstorming

## What we actually need

Based on real usage patterns (analyzable from Claude Code session files on disk):

### Core tool loop
- Send messages + tool definitions to LLM
- Model returns tool calls
- Execute tools, feed results back
- Repeat until done

### Tools (priority order based on actual usage)
1. **Read** — read files
2. **Edit** — diff-based file editing
3. **Bash** — shell execution
4. **Grep** — content search (ripgrep)
5. **Glob** — file pattern matching
6. **Write** — create new files
7. **WebSearch** — web search
8. **WebFetch** — fetch URLs

### Provider abstraction
Thin adapter: `send_message(messages, tools) -> response`

Each provider needs:
- Auth handling (API key, OAuth, session token — whatever the provider uses)
- Message format translation (minor differences between providers)
- Tool schema translation (mostly compatible, small differences)
- Streaming support

Provider types:
- **API key providers**: Anthropic, OpenAI, Google, z.ai, OpenRouter
- **Local inference**: ollama, vllm (OpenAI-compatible endpoints)
- **Subscription/session providers**: Claude Code protocol, Codex — reverse-engineer or wrap existing auth

### Context management
- Token counting per provider
- Compression/summarization when approaching limits
- Smart truncation (keep system prompt + recent turns, compress middle)

### Frontend interface
The harness exposes an API. Frontends are thin clients:
- **CLI** — stdin/stdout, readline
- **Telegram** — Carcin becomes a frontend client
- **API server** — HTTP/WebSocket for web UIs or other integrations

## What we can steal

- **Claude Code** (MIT) — tool implementations, especially Edit with fuzzy matching
- **Existing session files** — mine `~/.claude/` for actual tool usage patterns to prioritize what to build first

## Open questions

- Session file format: what's in there and how much can we learn from it?
- Subscription auth: how do coding subscriptions actually auth? OAuth? Session cookies? Custom tokens?
- Edit tool: how sophisticated does fuzzy matching need to be? Can we start naive and iterate?
- Context compression: roll our own or use the model to summarize?
- Permission system: do we need one from day one or can it be added later?
- Memory/skills: port the CLAUDE.md + memory system, or design something better?
