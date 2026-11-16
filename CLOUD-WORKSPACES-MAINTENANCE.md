# Personal cloud workspaces downstream

This branch is maintained in [Anjiro81/dreb](https://github.com/Anjiro81/dreb/tree/personal/cloud-workspaces), **not proposed for inclusion in upstream dreb**. It preserves the accepted Dashboard workflow without requiring upstream to maintain a niche feature. [Drew's feedback](https://github.com/aebrer/dreb/issues/564#issuecomment-6741110365) prompted this direction, approved by the user on 2026-11-09.

## Ownership and preserved baseline

- Maintenance branch: `personal/cloud-workspaces` in the existing fork. No second fork is required; leave the fork's `master` and default branch alone.
- Initial reviewed implementation: `0feba0a9e028142ba11bcdcc0dcf1c53cbee3a32`. It already contains the foundation and Dashboard dependency commits. Continue development on **one** downstream branch, not three independently evolving feature branches.
- Upstream base of that implementation: `65e68acaf60c655206ef18ecf62752c66b4b58af` (2.79.0).
- Historical proposals: [PR565](https://github.com/aebrer/dreb/pull/565), [PR566](https://github.com/aebrer/dreb/pull/566), [PR567](https://github.com/aebrer/dreb/pull/567). These proposals are being withdrawn without merging or deleting their branches, commits, plans or review history. Their old readiness/dependency descriptions are historical, not active upstream delivery promises.
- [Issue564](https://github.com/aebrer/dreb/issues/564) remains open for its maintainer to decide its upstream disposition. This downstream does not claim completion of its broader history-portability goals.

The retained feature is a **fork integration**, not an already extracted extension. Current extension APIs provide commands, tools, lifecycle hooks and dialogs, but no registration hooks for these built-in Dashboard Settings and linked-project launch/resume controls. Preserve those controls while reducing integration coupling gradually; do not label a package a drop-in extension merely because some logic moves into it.

## Retained contract

Keep lowercase **Settings → Devices → cloud workspaces**, a pasteable native backend-host path, Connect, explicit genuinely new-folder Setup, closed advanced/manual controls, path-first rows and technical details. The rejected folder picker must remain absent. Preserve existing IDs and bindings; do not silently repair, initialize or rebind after unrelated failures. Canonical missing-marker context, captured-ID retry and canonical-target-bound setup consent remain necessary safeguards.

Project linking and optional **global** main/subagent log defaults are independent. Connecting never enables logs; log save/reset requires separate consent. Preserve literal whitespace, host-native path semantics, normal local launch without registry access, exact transcript/parent identity and historical versus effective CWD. Metadata operations must remain cold and authenticated. Credentials, settings, trust and device-local mappings stay local.

No migration, copying/deletion of logs, target-log-directory creation, active-session relocation, automatic restart, per-project routing, automatic history reassociation/resume, full-history handoff or distributed-cloud writer guarantees are added by maintaining this branch. Logs-only roots and projects outside synced folders remain supported.

## Get a durable checkout

For a fresh checkout:

```sh
git clone --branch personal/cloud-workspaces https://github.com/Anjiro81/dreb.git dreb-cloud
cd dreb-cloud
git remote add upstream https://github.com/aebrer/dreb.git
```

Here `origin` is the personal fork and `upstream` is aebrer/dreb. Development logs and temporary test profiles do not belong in the source tree. Keep the existing lockfile and the repository-pinned Node/npm toolchain. A clone does not include dependencies or compiled output; explicitly bootstrap dependencies when appropriate, rather than silently installing them from a launcher.

## Build and check before use

Follow [AGENTS.md](AGENTS.md) and the [development guide](packages/coding-agent/docs/development.md). Use the Node version in `.nvmrc` and its bundled npm. A first checkout needs a reviewed dependency bootstrap (`npm ci`, including the normal Husky prepare step), then a build before the first type check: generated model sources and exported declaration files do not exist in a source-only clone. This adoption reused existing local dependencies and validated build artifacts without a dependency/browser/model-weight install.

Every development check, build, test and commit hook must use disposable `HOME`, `USERPROFILE` and `DREB_CODING_AGENT_DIR`, explicit offline/no-local-LLM flags, and existing browser binaries. For example, from a checkout whose dependencies and Chromium cache are already available:

```sh
CHECK_ROOT="$(mktemp -d)"
mkdir -p "$CHECK_ROOT/home" "$CHECK_ROOT/agent"
BROWSER_CACHE="/absolute/path/to/existing/ms-playwright"
(
  export HOME="$CHECK_ROOT/home" USERPROFILE="$CHECK_ROOT/home"
  export DREB_CODING_AGENT_DIR="$CHECK_ROOT/agent"
  export DREB_LIVE_API=0 DREB_LIVE_API_EXPENSIVE=0 DREB_NO_LOCAL_LLM=1
  export PLAYWRIGHT_BROWSERS_PATH="$BROWSER_CACHE"
  npm run build
  npm run check
  npm run verify-workspace-links
  bash test.sh
)
```

Use the appropriate Node executable on `PATH`. These flags disable live-provider/local-LLM tests, not all network traffic: the existing standard build refreshes unauthenticated public model catalogs. A completely network-isolated, reproducible artifact build remains a separate packaging task; do not claim these flags provide it. Do not enable paid/live-provider tests, download browser binaries/model weights or inspect real provider/settings/log files as part of a check. Keep the disposable evidence until results have been recorded. The normal commit hook must run without bypass under the same isolation. GitHub/Git credential operations can retain their normal authentication context, but **every executed Git hook** must receive the disposable profile; do not disable hooks to work around that distinction.

Retain focused regressions for identity/disconnect/native aliases/consent, first settings creation versus a helper subprocess, authenticated cold metadata, local bypass, exact-parent resume and pending modal ownership. Build before compiled browser/filesystem acceptance, using temporary host folders and profiles. Synthetic Chromium and fixture evidence is not native Windows/Safari, real Tailscale/cloud/provider or full-history certification. Required root checks do not turn the separately documented optional client-only baseline diagnostics into a pass.

The normal CI check and test jobs run on pushes to this maintenance branch as well as `master`; upstream-style coverage still runs on pull requests targeting `master`. Inspect checks for the **exact pushed commit**. The inherited npm publishing job is restricted to the upstream repository, so a fork release cannot accidentally attempt to publish its `@dreb/*` namespaces.

## Distinct source launcher; no automatic installation

After a validated build, the repository provides:

```sh
node /absolute/path/to/dreb-cloud/scripts/dreb-cloud.mjs [normal dreb arguments]
# Dashboard dispatch uses this checkout's matching workspace package:
node /absolute/path/to/dreb-cloud/scripts/dreb-cloud.mjs dashboard [dashboard arguments]
```

The launcher preserves the caller's working directory, arguments and environment and selects this checkout's compiled CLI. It refuses a missing build; it never installs dependencies, builds, updates, patches global packages, changes settings or restarts an existing service. It also preserves the normal compiled entrypoint identity for descendant processes. No command or service named `dreb-cloud` is installed automatically; a separately approved installation may add a distinct alias/launcher later.

**A distinct command is not profile isolation.** Normal execution still uses existing dreb configuration unless explicitly configured otherwise. Do not assume stock and downstream processes have independent settings/logs, or that overriding the agent directory isolates every Dashboard authentication file. Do not run a second live deployment casually against the same state. Tests use disposable home and agent directories; actual deployment/profile selection is a separate decision.

Do not use `npm link` or patch `/opt/homebrew/lib/node_modules` as the maintenance/update strategy. The current application and historical rollback receipts remain untouched by this adoption. Source changes are not automatically installed.

## Update from upstream deliberately

Choose a specific upstream release/commit; do not automatically track and deploy every `master` push. Start from a clean maintenance checkout:

```sh
git switch personal/cloud-workspaces
git fetch upstream --tags
# Inspect the chosen revision before merging; replace UPSTREAM_REVISION.
git log --oneline HEAD..UPSTREAM_REVISION
git merge --no-ff UPSTREAM_REVISION
```

Run merges and their normal hooks under the check-profile isolation above. Resolve conflicts deliberately, preserving the retained contract and tests. Review the resulting diff against the **actual** upstream revision, rerun required and focused checks, push to the personal fork without force, and verify exact-head CI. No upstream feature merge is a prerequisite for maintaining this branch now. Keep independently useful bug fixes separate from cloud-specific changes when possible; discuss upstream interest before opening unrelated proposals.

For a future distributable, use an owned versioned release/build identity, pinned dependencies and a manifest of exact source and compiled bytes. The displayed inherited `2.79.0` is not enough to distinguish private builds. Follow the version-sync/release requirements before any release tag; preserve MIT attribution and do not publish under upstream-owned npm names. A renamed package layout, release bundle, global launcher and automated deployment/rollback are **not delivered by this initial source-branch adoption**. Do not create a release, bump versions, migrate profiles or replace installed packages just to establish ownership.

## Gradual extraction, not a rewrite

1. Keep the reviewed implementation and regression suite as the behavior baseline.
2. Plan extraction of marker/schema/registry and optional storage logic behind a narrow owned package boundary. Preserve shared locking with ordinary settings writers; moving a helper must not reintroduce the acknowledged-pair race.
3. Keep explicitly identified Dashboard routing/API/selection and core adapters in the downstream. A package plus private adapters is still a downstream integration, not a zero-patch extension.
4. Add optional command/tool adapters only where existing public APIs suffice. Consider a companion UI only as an explicit product tradeoff, not a silent replacement of the accepted Dashboard workflow.
5. Propose small generic upstream hooks or bug fixes only with maintainer interest. Do not turn extraction into a new upstream plugin framework obligation.

Record new plans, fixes, validation and release decisions in the personal fork's issues or pull requests. Do not reopen the withdrawn feature proposals merely to store ongoing private maintenance notes.
