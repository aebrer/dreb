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

## Release Protocol

**Every release MUST follow these steps in order. No exceptions.**

**The version bump happens on the feature branch, BEFORE merge.** The default branch (master) requires PRs for all changes — you cannot push commits directly to it.

1. **Bump version**: Update `version` in the root `package.json` (on the feature branch)
2. **Sync**: Run `npm run sync-version` (or let `npm run build` do it — the build script runs `sync-version.sh` automatically)
3. **Build**: Run `npm run build` to compile with the new version
4. **Verify**: Launch the binary and confirm the TUI welcome message shows the correct version
5. **Commit & push**: Commit the version bump (all `package.json` files touched by sync) and push to the feature branch
6. **Merge**: Merge the PR (squash) after CI passes
7. **Tag**: On the default branch after merge: `git tag v<version> && git push --tags`

**The version in `package.json` is the source of truth.** The TUI reads it at runtime via `config.ts`. If the version in `package.json` doesn't match the release, the TUI will show the wrong version to users.

**Never create a git tag without first bumping `package.json` to match.**

## Completeness Rule

**Don't defer parts of categorical work.** If the task is "fix docs," fix ALL docs — don't cherry-pick the easy ones and punt the rest to a follow-up. Same applies to failing tests and discovered bugs: if you find it during the work, fix it now. "Out of scope" is not an excuse to ship known-broken things.

## Testing

```bash
npm test          # Run all workspace tests
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
```

Linting:

```bash
npx biome check --write <files>
```
