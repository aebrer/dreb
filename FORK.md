# Fork Documentation

## Source
- **Repository:** https://github.com/badlogic/pi-mono
- **Commit:** `fb10d9aef9c9f0b84e690482f044250c6fc2ce49`
- **Date:** 2026-03-26
- **License:** MIT — original copyright notice preserved in this file

## What was removed
- `packages/mom/` — Slack bot (we're building Telegram via Carcin instead)
- `packages/pods/` — vLLM GPU pod management (not needed)
- `packages/web-ui/` — Web UI components (may revisit later)
- `packages/web-ui/example` workspace entry
- Release/publish/version scripts (we manage releases ourselves)
- Profile scripts, browser-smoke check (web-ui specific)

## What was kept
- `packages/ai/` — LLM provider abstraction (18+ adapters, OAuth) → `@dreb/ai`
- `packages/agent/` — Agent runtime, transport, state management → `@dreb/agent-core`
- `packages/tui/` — Terminal UI with differential rendering → `@dreb/tui`
- `packages/coding-agent/` — CLI, tools, extensions, sessions → `@dreb/coding-agent`

## Rebranding
- CLI command: `pi` → `dreb`
- Config directory: `.pi/` → `.dreb/`
- Package names: `@mariozechner/pi-*` → `@dreb/*`
- System prompt: references "dreb" not "pi"
- Config key: `piConfig` → `drebConfig` in package.json

## Maintenance policy
This is a hard fork, not a tracking fork. We maintain independently.
Cherry-pick from upstream when something useful lands, after reading the diff.
