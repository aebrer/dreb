# AGENTS.md — dreb Development Guide

## Build Requirement

**You MUST run `npm run build` after ANY code change before testing with the real `dreb` binary.** The CLI runs compiled JS from `dist/`, not TypeScript source. Vitest transpiles TS on the fly, so tests will pass even with a stale build — but manual testing against the binary will use old code.

```bash
npm run build
```

This builds all packages in dependency order: tui → ai → agent → coding-agent.

## Monorepo Structure

- `packages/ai` — Model registry, provider APIs, types
- `packages/agent` — Core agent loop, event system, types
- `packages/coding-agent` — CLI tool, tools, model resolution, TUI
- `packages/tui` — Terminal UI components

## Testing

```bash
npm test          # Run all workspace tests
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
```

Linting:

```bash
npx biome check --write <files>
```
