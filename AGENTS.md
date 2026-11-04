# AGENTS.md — dreb Development Guide

## Build Requirement

**You MUST run `npm run build` after ANY code change before testing with the real `dreb` binary.** The CLI runs compiled JS from `dist/`, not TypeScript source. Vitest transpiles TS on the fly, so tests will pass even with a stale build — but manual testing against the binary will use old code.

```bash
npm run build
```

This builds all packages in dependency order: tui → ai → agent → semantic-search → coding-agent → telegram → dashboard.

`npm run build` is a **pure compile step** — it does not bump versions or touch `package-lock.json`. Version syncing is a separate, explicit release operation (`npm run sync-version`); see Release Protocol below. CI enforces this: a build that mutates `package-lock.json` fails the lint/type-check job.

## Node & npm Toolchain

**One toolchain everywhere: Node.js 26 LTS and the npm it bundles.** Local development, CI, publishing, and lockfile writing all use it — there is no second npm version and no mid-job npm upgrade.

- **Pin:** `.nvmrc` and `.node-version` hold the exact Node version (`nvm install` / `nvm use` in the repo picks it up). Every CI job and the publish workflow use `actions/setup-node` with `node-version-file: .nvmrc`, so the bundled npm is identical in all automation. That npm (≥ 11.5.1) also satisfies npm trusted publishing (OIDC provenance).
- **Enforcement is done by npm itself:** the root `package.json` `devEngines` requires `node ^<pin>` and `npm ^<bundled npm>` with `onFail: "error"`, so `npm install` / `ci` / `run` fail with `EBADDEVENGINES` on any other Node or npm major. `engines.node` (the runtime users need) is the same range in the root and every workspace.
- **Single lockfile writer:** only the pinned npm writes `package-lock.json`. CI verifies the lockfile is consistent (`npm ls --all`) and canonical (`npm install --package-lock-only` must be a byte-for-byte no-op), then that `npm run build` leaves it untouched. Different npm versions write different lockfiles (npm 10 vs 11 differed in `peer` flags, optional-peer entries, and dedupe), so never commit a lockfile written by another npm.
- **`overrides` gotcha:** adding or changing an `overrides` entry does not re-resolve an already-locked package — npm keeps the old version and merely marks it invalid. Run `npm update <pkg>` for the overridden package, then confirm `npm ls --all` passes (CI enforces it).
- **Dependency install scripts run only after review.** The pinned npm checks every dependency install script against the root `allowScripts`. On its own it merely warns and still runs a script that has no recorded decision, so the repo `.npmrc` sets `strict-allow-scripts=true`: any install (local, CI, or the publish job) that would run an unreviewed script fails with `ESTRICTALLOWSCRIPTS` before anything executes. (npm 10 and 11.5.1 ran every dependency script unconditionally.) All current entries are `false` because none is needed: prebuilt/WASM binaries ship in the packages (including `fsevents`' macOS binary), and `onnxruntime-node`'s script only downloads CUDA providers dreb does not use. To record a decision for a new package, review its script, then run `npm install-scripts approve <pkg>` or `npm install-scripts deny <pkg>`. `npm install-scripts ls` only sees packages installed on the current platform, so also check the lockfile: every entry with `"hasInstallScript": true` needs a decision, including platform-specific ones such as the macOS-only `fsevents`.
- **Bumping Node:** one PR that updates `.nvmrc`, `.node-version`, `devEngines` (runtime and the newly bundled npm), and `engines.node` together, then re-normalizes the lockfile with the new npm. `npm run verify-engines` (run in CI) fails if the pins, `devEngines`, and `engines` disagree.

## Monorepo Structure

- `packages/ai` — Model registry, provider APIs, types
- `packages/agent` — Core agent loop, event system, types
- `packages/coding-agent` — CLI tool, tools, model resolution, TUI
- `packages/tui` — Terminal UI components
- `packages/telegram` — Telegram bot integration
- `packages/semantic-search` — Semantic codebase search engine + MCP server
- `packages/dashboard` — Web dashboard (Express server + SolidJS client over RPC)

## Workspace Link Safety

npm v9 changed `install-links` to default `true`. This causes local workspace packages to be packed and installed as stale tarball copies instead of symlinked. When this happens you get silent, hard-to-debug failures because nested `node_modules/@dreb/*` directories contain outdated published code instead of your local workspace source.

**How we made it safe:**
- `.npmrc` at repo root sets `install-links=false`

With this protection in place, `npm install` and `npm ci` will correctly symlink local workspace packages. (The `workspace:*` protocol would be even better, but it is currently broken in npm 11 — see npm/cli#8845.)

Verify workspace links are healthy before declaring a build good:

```bash
npm run verify-workspace-links
```

If it reports stale packages, remove the stale directories and re-establish workspace symlinks locally.

## Release Protocol

**Every release MUST follow these steps in order. No exceptions.**

**The version bump happens on the feature branch, BEFORE merge.** The default branch (master) requires PRs for all changes — you cannot push commits directly to it.

1. **Bump version**: Update `version` in the root `package.json` (on the feature branch)
2. **Sync**: Run `npm run sync-version`. This propagates the root version to all `packages/*/package.json`, plugin manifests, and the workspace `version` fields in `package-lock.json`. It does **not** re-resolve dependencies. (`npm run build` no longer does this for you — syncing is now an explicit step.)
3. **Build**: Run `npm run build` to compile with the new version
4. **Verify**: Launch the binary and confirm the TUI welcome message shows the correct version
5. **Commit & push**: Commit **all** version-bumped files and push to the feature branch. The sync script prints the full list, but at minimum: `package.json`, `package-lock.json`, all `packages/*/package.json`, and any `packages/*/.claude-plugin/plugin.json`
6. **Merge**: Merge the PR (squash) after CI passes
7. **Tag**: On the default branch after merge: `git tag v<version> && git push --tags`

**The version in `package.json` is the source of truth.** The TUI reads it at runtime via `config.ts`. If the version in `package.json` doesn't match the release, the TUI will show the wrong version to users.

**Never create a git tag without first bumping `package.json` to match.**

## Documentation

**The root `README.md` is the most important documentation file in this repo.** It is the first thing users and contributors see. When features, tools, or capabilities change, the root README must be updated alongside `packages/coding-agent/README.md` and any relevant files in `packages/coding-agent/docs/`. Do not assume that updating package-level docs is sufficient — if the root README describes the feature, it must stay accurate.

Documentation files to check on every feature change:
- `README.md` (root — the public face of the project)
- `packages/coding-agent/README.md` (detailed product docs)
- `packages/coding-agent/docs/` (feature-specific docs: extensions, json, rpc, sdk, etc.)
- `AGENTS.md` (this file — development guide)

## Nested Context Trust Boundary

The initial startup scan still walks upward from the main or subagent launch cwd and is separate from lazy nested/out-of-cwd loading. Lazy loading defaults **off**. Its global-only policy lives in `~/.dreb/agent/settings.json`: `context.trustedFolders` grants canonical existing roots and descendants, with native-realpath matching that denies symlink escapes. Project `.dreb/settings.json` cannot add or override trusted roots or enable loading.

`context.autoLoadNested: true` is a global-only expert trust-all override, not a normal per-project setting. It allows any resolvable target's `AGENTS.md`/`CLAUDE.md` to be injected and therefore crosses a prompt-injection trust boundary. Prefer explicit trusted roots. Main and subagent processes use the same policy and observe changes for future lazy loads; already injected context cannot be removed. Lazy injected content remains secret-scrubbed, ordered after extension `tool_result` transforms, and deduplicated per session.

## Completeness Rule

**Don't defer parts of categorical work.** If the task is "fix docs," fix ALL docs — don't cherry-pick the easy ones and punt the rest to a follow-up. Same applies to failing tests and discovered bugs: if you find it during the work, fix it now. "Out of scope" is not an excuse to ship known-broken things.

## No Ignoring Pre-Existing Failures

**There is no such thing as a "pre-existing" test or lint failure that's okay to ignore.** If a test fails or a linter complains — whether it's in files you touched or not — it gets fixed. No bypassing with `--no-verify`, no rationalizing that it's "unrelated," no deferring to a future PR. If CI would fail on it, it's your problem now.

## UI Ordering — Determinism Over Recency

**Lists of live/long-lived UI cards (fleet sessions, agent strips, etc.) must always sort deterministically. Defaults and other surfaces must use stable keys, not dynamic activity.** Order by a stable key (e.g. project path alphabetical, then runtime start time as tiebreak) so cards keep a fixed position. Sorting by `lastActivity` or other constantly-changing signals makes cards jump around on every event — consistency is better UX than implicit dynamic reordering. For default ordering and other surfaces, use stable fields for new ordering dimensions rather than mutable activity signals.

**Narrow exception: explicitly user-selected Fleet home sorts may reorder on updates to the selected key.** Selecting Last activity opts only Fleet into live activity reordering; Default remains stable path/start ordering, unaffected by activity or status changes. Session and subagent fleet sidebars retain their stable path/start comparator regardless of the Fleet preference. Every comparator must still use deterministic ties; reversing the selected direction must not reverse equal-value tiebreaks.

## Testing

```bash
npm test          # Run all workspace tests (offline: live provider tests skip)
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
```

**Live provider tests are opt-in and cost real money/quota.** They only run with `DREB_LIVE_API=1` (context-overflow tests also need `DREB_LIVE_API_EXPENSIVE=1`). Never enable them without explicit approval, and scope them to a single file/provider. New live tests must gate on `isLiveApiEnabled()` from the package's `test/live-api.ts` — see `packages/coding-agent/docs/development.md`.

Linting:

```bash
npx biome check --write <files>
```
