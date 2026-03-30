# Development

See [AGENTS.md](../../../AGENTS.md) for build requirements, release protocol, and the completeness rule.

## Prerequisites

- **Node.js** ≥ 20.0.0 (CI runs on Node 25)
- **npm** (comes with Node)

## Setup

```bash
git clone https://github.com/aebrer/dreb
cd dreb
npm install
npm run build
```

Run from source:

```bash
node /path/to/dreb/packages/coding-agent/dist/cli.js
```

The script can be run from any directory. dreb keeps the caller's current working directory.

## Monorepo structure

```
packages/
  ai/           # Model registry, provider APIs, types (@dreb/ai)
  agent/        # Core agent loop, event system, types (@dreb/agent-core)
  tui/          # Terminal UI components (@dreb/tui)
  coding-agent/ # CLI, tools, interactive mode, TUI app (@dreb/coding-agent)
```

Dependencies flow one way: `coding-agent` → `agent` → `ai`, and `coding-agent` → `tui`. Changes to a dependency require rebuilding downstream packages — `npm run build` handles this automatically in the correct order.

## Code style

The project uses [Biome](https://biomejs.dev/) for linting and formatting:

```bash
npx biome check --write <files>    # Lint + format
npx biome check --write .          # Whole repo
```

A pre-commit hook runs biome checks, tests, and `tsgo --noEmit` (matching CI) automatically.

## Testing

```bash
npm test                                           # All workspace tests
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
bash test.sh                                       # Match CI exactly (unsets API keys first)
```

Tests that require API keys are skipped when keys aren't available. CI runs `bash test.sh`, which unsets all API keys before running the suite for clean isolation. Use this locally when you want to match CI exactly.

## Type checking

```bash
npx tsgo --noEmit
```

CI runs this across the full repo including `examples/`. Run it locally before committing — tests alone won't catch type errors in non-test files.

The pre-commit hook runs in order: biome check → `tsgo --noEmit` → `test.sh`.

## Contributing

1. Open an issue describing the change
2. Create a feature branch from `master`
3. Make changes, ensure tests pass and `tsgo --noEmit` is clean
4. Open a PR against `master` — CI must be green before merge

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "drebConfig": {
    "name": "dreb",
    "configDir": ".dreb"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

dreb runs in three execution modes (npm install, standalone binary, tsx from source), all of which need to find package assets correctly.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.dreb/agent/dreb-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM
