# AGENTS.md — dreb Development Guide

## Build Requirement

**You MUST run `npm run build` after ANY code change before testing with the real `dreb` binary.** The CLI runs compiled JS from `dist/`, not TypeScript source. Vitest transpiles TS on the fly, so tests will pass even with a stale build — but manual testing against the binary will use old code.

```bash
npm run build
```

This builds all packages in dependency order: tui → ai → agent → coding-agent → telegram.

## Monorepo Structure

- `packages/ai` — Model registry, provider APIs, types
- `packages/agent` — Core agent loop, event system, types
- `packages/coding-agent` — CLI tool, tools, model resolution, TUI
- `packages/tui` — Terminal UI components
- `packages/telegram` — Telegram bot integration

## Release Protocol

**Every release MUST follow these steps in order. No exceptions.**

**The version bump happens on the feature branch, BEFORE merge.** The default branch (master) requires PRs for all changes — you cannot push commits directly to it.

1. **Bump version**: Update `version` in the root `package.json` (on the feature branch)
2. **Sync**: Run `npm run sync-version` (or let `npm run build` do it — the build script runs `sync-version.sh` automatically)
3. **Build**: Run `npm run build` to compile with the new version
4. **Verify**: Launch the binary and confirm the TUI welcome message shows the correct version
5. **Commit & push**: Commit **all** version-bumped files and push to the feature branch. The sync script prints the full list, but at minimum: `package.json`, `package-lock.json`, all `packages/*/package.json`, and any `packages/*/.claude-plugin/plugin.json`
6. **Merge**: Merge the PR (squash) after CI passes
7. **Tag**: On the default branch after merge: `git tag v<version> && git push --tags`

**The version in `package.json` is the source of truth.** The TUI reads it at runtime via `config.ts`. If the version in `package.json` doesn't match the release, the TUI will show the wrong version to users.

**Never create a git tag without first bumping `package.json` to match.**

## Completeness Rule

**Don't defer parts of categorical work.** If the task is "fix docs," fix ALL docs — don't cherry-pick the easy ones and punt the rest to a follow-up. Same applies to failing tests and discovered bugs: if you find it during the work, fix it now. "Out of scope" is not an excuse to ship known-broken things.

## No Ignoring Pre-Existing Failures

**There is no such thing as a "pre-existing" test or lint failure that's okay to ignore.** If a test fails or a linter complains — whether it's in files you touched or not — it gets fixed. No bypassing with `--no-verify`, no rationalizing that it's "unrelated," no deferring to a future PR. If CI would fail on it, it's your problem now.

## Testing

```bash
npm test          # Run all workspace tests
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
```

Linting:

```bash
npx biome check --write <files>
```
