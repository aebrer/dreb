# Cloud Workspaces

Cloud workspaces are a provider-neutral identity registry with CLI, SDK and optional Dashboard management for mapping the same project ID to different existing local folders on different computers. Management is **metadata only**; explicit Dashboard directory selection can use a linked ID to start/resume a runtime. This is not full session portability or a sync service.

Use folders you already manage, including folders delivered by a desktop sync client. Registry management makes no cloud-provider OAuth/API/network calls; Dashboard uses its authenticated backend API. A desktop client may transfer the metadata you explicitly request; dreb does not verify that delivery.

## Dashboard setup

Open **Settings → Devices → cloud workspaces**, or go directly to `#/settings/cloud-workspaces`. The link is in a separate cloud workspaces subsection below the Devices pairing/access controls. This independent screen does not mount ordinary Settings/model/version loaders. Enter or paste **native absolute paths on the backend host** (for example, `/Users/alex/SharedWork` or `D:\SharedWork`), not paths on your phone/browser. No terminal commands or model credentials are needed for management. Added later at the user's request, the adjacent **Browse folders…** button offers a managed backend-host folder menu; the input remains freely editable/pasteable. There is no native OS folder picker, browser upload, persisted browser selection or cloud-mapping polling; use **Refresh metadata** explicitly.

1. Type/paste **Folder path on this computer** in the single basic input, or explicitly click **Browse folders…** and **Choose folder** to fill it. Then separately choose **Connect folder**. It reuses an existing project marker or known already-registered mapping; no separate workspace setup or typed UUID is required. The folder must already exist. Only an exact missing-project-marker result offers **Set up folder** with explicit first-device confirmation for the captured path. It never initializes automatically or repairs a missing required identity by inventing another one.
2. Project rows show folder paths first. Open **technical details** for full IDs, configured bindings/root relationships and marker details. **Refresh metadata** reports canonical available paths and per-row errors. **Available** means locally reachable with valid required metadata, not delivered elsewhere or equivalent code. Rows are ordered by stable ID, not activity/availability. Failed refreshes retain last-good rows labelled stale, not a misleading empty registry; failed mutations retain entered values and report errors, including partial initialization guidance.
3. Open the closed native **advanced setup** disclosure for manual **Connect workspace**/**Link project** forms and workspace management. Connect a delivered workspace marker using **Existing identity**, or deliberately choose **Initialize first marker** on the first host only. Manual project linking retains **Existing marker**, **Initialize first marker** (once), or **Known full ID (markerless)**. The last mode explicitly binds a known project UUID without creating a missing marker; any existing marker must agree. Choose **Direct local** or an explicit **Workspace-relative** relationship and enter an absolute host path in either case. No folders are moved; connecting a root does not discover all its projects. Direct-local projects may be outside synced roots.
4. Use **Rebind workspace/project** after a move to target the same full identity. Workspace rebinds require its matching marker. Project rebinds explicitly supply the row's known ID and retain known-ID markerless semantics; a conflicting marker is rejected. No replacement identity is initialized. Confirm **Unlink project** or **Disconnect workspace** to remove only this host's mapping. Markers, folders, cloud content and transcript bytes are preserved; dependent project IDs stay visible but unavailable until reconnected or rebound.

**Initialize each shared workspace/project marker once.** On other hosts, wait for its delivery, then connect/link the existing identity. A missing required marker is not permission to initialize a replacement. If `PARTIAL_INITIALIZATION` reports a preserved marker, fix the local failure and retry with that same identity.

### Browsing an existing host folder

**Browse folders…** opens the managed, keyboard-accessible **Choose a folder on this computer** modal only on explicit activation—not on page mount, clicking/focusing the path input or editing it. Browse the **backend computer**, not your phone/browser: use **Home folder**, **Up one folder**, or edit **Browse location on this computer** and choose **Go to folder**. The list contains folders only, with loading, error/**Retry**, empty and truncation feedback. **Choose folder** fills the basic path input and invalidates previous path-bound setup/log confirmations; it never connects a project, initializes metadata, saves log settings or restarts anything. **Cancel folder selection**, Escape or backdrop dismissal leaves the input unchanged.

Browsing is read-only immediate filesystem metadata access: no recursive scan, file contents, logs, markers, settings, project context, registry, trust evaluation, utility/RPC/agent runtime or provider discovery. Existing directory symlinks may be opened through canonical validation; broken/unreadable entries are omitted. Each listing inspects at most 10,000 entries and returns at most 500 folders, sorting the returned names. A truncation notice means some names were omitted, not that the list contains every matching folder; enter the full native path to reach an omitted folder. Errors can be retried or bypassed by typing/pasting a path.

No native OS dialog, `showDirectoryPicker`, directory upload, folder creation, new browser persistence or polling is added. Browsing uses the dedicated authenticated [`POST /api/cloud-workspaces/folders`](dashboard.md#cloud-workspace-api), not the ordinary Files listing endpoint, which evaluates trust through a utility runtime. Connecting/setup and optional log saving remain separate explicit actions with their existing confirmations.

### Optional session-log storage

Project linking and log configuration are **independent operations**, not a combined marker/registry/settings transaction. Use the same **Folder path on this computer** input, choose **Store session logs here**, review the locations, then explicitly confirm **Save log locations**. The folder can be logs-only: it need not be a connected project or workspace, and runnable projects can remain elsewhere.

The selected root must be a native absolute existing readable/writable/searchable backend directory. dreb canonicalizes it and derives `<root>/.dreb/sessions` for main logs and `<root>/.dreb/subagent-sessions` for child logs (`.dreb` follows `CONFIG_DIR_NAME`). Existing derived path components are checked; files and symlinks there are rejected. Saving updates only the existing global `sessionDir` and `subagentSessionDir` fields in host-local `<agent-dir>/settings.json`, preserving all other settings. These are defaults for **all projects**, not a project-specific route or new cloud-preference key. Current configured/default locations are shown separately from the input.

Opening/reading the page, browsing/choosing a folder, basic connect, path edits or cancelling confirmation never changes log settings. Choosing a folder invalidates earlier path-bound setup/log confirmations; it is not consent to save. To reset, choose **Use local log defaults** and confirm **Save log locations**; this removes only those two global fields. Saves compare the expected current pair against a fresh settings read under `settings.json.lock`; stale values fail with `409 CONFLICT` and require a reload. Malformed/nonregular metadata is rejected without overwrite. Mapping and storage failures remain separate; a log-save failure does not undo or retry a successful project link.

Saving or resetting creates **no target log directories, markers, registry or logs**, moves/copies/deletes **no existing logs**, changes no active session files and performs no restart. It only changes future process defaults: main sessions retain CLI → merged project/global → extension-hook → built-in precedence, while subagent storage remains global-only. Machine configuration, authentication, trust and the mapping registry stay local.

Dashboard inventory keeps the global main root it actually snapshotted at startup. `restartRequired` compares the current configured main root with that active snapshot, not with the previous save. Restart Dashboard only when agents are idle to switch inventory; saving never does this for you. The new inventory may not list logs in an old flat root, but those files remain accessible by exact path. There is no migration, concurrent-writer safety, sync service or full-history handoff. See [session settings](settings.md#sessions), [session compatibility](session.md#cloud-workspace-compatibility), the [REST contract](dashboard.md#cloud-workspace-api) and the [storage SDK API](#sdk-api).

### Choosing a runtime directory

Every **New Session** and replacement-directory dialog initially uses **local directory**, including after a prior linked choice. Ordinary local workflows need no registration and do not query the registry. Explicitly switch to **linked project** to load choices, select one full project ID, or follow **manage Cloud Workspaces**. There is no automatic project selection or fallback folder. This control appears in New Session and replacement flows for Fleet history, closed main Session, and the closed parent resumed from Subagent view; the latter resumes the captured parent transcript, not a child as a main session.

The browser sends the selected ID, never its cached display path alongside the ID. The backend resolves it immediately before canonical directory validation and runtime creation. Missing/disconnected mappings, changed required markers, containment violations or inaccessible paths prevent launch without fallback. Displayed availability is advisory, not a transactional filesystem snapshot.

Connect/link/status/rebind/removal do not start utility/agent runtimes, load project settings/context/extensions, discover providers, read transcripts or alter trust. The existing Dashboard shell retains its normal session inventory and SSE. **Start/Resume is execution:** it follows normal settings, initial upward context scan, extensions and resource startup in the chosen directory. Linking is neither a trust grant nor proof that the checkout matches the transcript. Directory selection does not persist a main/subagent project association, move session files or change storage precedence. See [Dashboard API](dashboard.md#cloud-workspace-api) and [session compatibility](session.md#cloud-workspace-compatibility).

## Getting started

All selected workspace and project folders must already exist and be readable/searchable. Initialization creates identity metadata, not the project folders. CLI relative paths resolve from the caller's current directory; `~` is supported. Directory arguments and agent-directory paths preserve literal whitespace in names; empty directory arguments are rejected.

```bash
# Run once in an existing folder tree; record each returned full UUID.
dreb cloud connect ~/SharedWork --init
dreb cloud link ~/SharedWork/widget --init --workspace WORKSPACE_UUID
dreb cloud list
dreb cloud status
dreb cloud resolve PROJECT_UUID
```

`WORKSPACE_UUID` and `PROJECT_UUID` throughout these commands are placeholders: replace them with the full UUIDs returned by `connect` and `link`. Workspace and project identities/records occupy separate namespaces: the same UUID string is allowed in both without making them the same identity. Distinct projects within the project namespace must still have distinct project IDs. Partial UUIDs are not accepted.

- `connect --init` creates a workspace marker, or reuses its existing valid identity. Without `--init`, `connect` requires an existing workspace marker.
- `link --init` creates a project marker, or reuses its existing valid identity. Without `--init` or `--id`, `link` requires an existing project marker.
- `--workspace` explicitly stores a project relative to a connected workspace. Without it, `link` stores a direct local path **even if the project is inside a synced root**.
- One ID has one explicit binding on each device. Changing its location requires `--rebind`.

**Initialize a shared identity once.** Wait for its marker to arrive before connecting or linking on another computer. Initializing independently on multiple offline devices is not distributed-safe; local locks do not coordinate cloud delivery or conflict ordering.

## Two computers, different roots

This is an illustrative setup, not a claim of provider or second-OS certification. Suppose a desktop client maps the same folder tree to `/Users/alex/SharedWork` on PC A and `D:\SharedWork` on PC B. The existing `widget` subfolder is present on both.

On PC A:

```bash
dreb cloud connect /Users/alex/SharedWork --init
# Record the returned workspace UUID as WORKSPACE_UUID.
dreb cloud link /Users/alex/SharedWork/widget --init --workspace WORKSPACE_UUID
# Record the returned project UUID as PROJECT_UUID.
```

Wait until both `.dreb/workspace.json` and `widget/.dreb/project.json` arrive on PC B. Then, in PowerShell on PC B, use the same full IDs:

```powershell
dreb cloud connect 'D:\SharedWork'
dreb cloud link 'D:\SharedWork\widget' --workspace WORKSPACE_UUID
dreb cloud resolve PROJECT_UUID
# Expected path: D:\SharedWork\widget
```

Each computer keeps its own registry. Shared markers carry identity, not either computer's paths. Connecting the root does not discover or register every project: explicitly link each project once per device. There is no basename guessing, automatic home/drive scan, or eager transcript hydration.

### Moving a workspace root

After moving the existing tree, including its markers, explicitly rebind the workspace on that device:

```powershell
dreb cloud connect 'E:\SharedWork' --rebind
dreb cloud resolve PROJECT_UUID
# Expected path: E:\SharedWork\widget
```

One root rebind changes resolution for all projects explicitly linked with `--workspace` to that workspace ID. Direct local project bindings do not follow it; relink those at their new directories with `--rebind`.

### Projects outside the synced tree

A project need not be inside a workspace. Initialize its identity and store a direct local path:

```bash
dreb cloud link ~/src/private-widget --init
# Record this project's returned full UUID as LOCAL_PROJECT_UUID.
```

`LOCAL_PROJECT_UUID` is a separate placeholder for this project's ID, not the earlier `widget` project ID. This creates local project metadata, but **does not automatically distribute it** to another computer. Transfer the project marker deliberately, or explicitly link the same full project ID on the other computer once. Never copy the device-local registry to accomplish this.

For a read-only or separately managed existing local folder, a known-ID link can avoid writing a marker:

```powershell
dreb cloud link 'C:\src\private-widget' --id LOCAL_PROJECT_UUID
```

`--id` and `--init` are mutually exclusive. If a project marker exists, it must agree with the supplied ID. If none exists, `--id` writes only a local binding with `markerRequired: false`; it does not create or distribute a marker. A later conflicting marker is still an error. Supply `--rebind` when changing an existing binding.

## CLI reference

```text
dreb cloud connect <directory> [--init] [--rebind] [--json]
dreb cloud link <directory> [--init | --id <project-uuid>] [--workspace <workspace-uuid>] [--rebind] [--json]
dreb cloud list [--json]
dreb cloud status [--json]
dreb cloud resolve <project-uuid> [--json]
dreb cloud unlink <project-uuid> [--json]
dreb cloud disconnect <workspace-uuid> [--json]
```

`dreb cloud` and `dreb cloud [command] --help` print help. Commands operate on metadata without starting a model session. Invalid commands fail with a nonzero exit status and a diagnostic on stderr; they never become model prompts.

| Command | Result |
|---|---|
| `connect` | Register a workspace root; `--json` returns a `CloudWorkspaceBinding` |
| `link` | Register a project; `--json` returns a `CloudProjectBinding` |
| `list` | Read registry configuration only, without validating folders; `--json` returns `CloudWorkspaceState` |
| `status` | Validate registered local folders and markers, with per-record availability/errors; `--json` returns `CloudWorkspaceStatus` |
| `resolve` | Validate and print **only** the canonical existing local project directory; `--json` returns `{projectId, path}` |
| `unlink`, `disconnect` | Remove only a local binding; `--json` returns `{id, removed}` |

`status` describes local availability, **not cloud sync status**. A successful local check does not prove another computer has received anything.

After reviewing the resolved folder, you may explicitly choose to change directories:

```bash
project_dir="$(dreb cloud resolve PROJECT_UUID)" && cd -- "$project_dir"
```

```powershell
$projectDir = dreb cloud resolve PROJECT_UUID
if ($LASTEXITCODE -eq 0) { Set-Location -LiteralPath $projectDir }
```

Check resolution succeeds before using its output. Resolution is not an execution decision or a trust grant: you still choose whether to run an agent or commands there and configure trust separately. There is no automatic launch or command replay.

## Shared markers and local schema

Marker locations use `CONFIG_DIR_NAME` (normally `.dreb`):

- `<selected-workspace>/.dreb/workspace.json`
- `<selected-project>/.dreb/project.json`

Each marker has exactly `version`, `kind`, and `id`. These are **example UUIDs**, not IDs to reuse:

```json
{"version":1,"kind":"workspace","id":"11111111-1111-4111-8111-111111111111"}
```

```json
{"version":1,"kind":"project","id":"22222222-2222-4222-8222-222222222222"}
```

Markers contain no machine paths, trust grants, or credentials. Their directories and files cannot be symlinks. Existing identities are reused, never silently reset. Invalid, incomplete, future-version, wrong-kind, or conflicting metadata is an error; a missing required marker is also an error, not permission to invent a replacement identity.

The **device-local** registry is `<agent-dir>/cloud-workspaces.json`, normally `~/.dreb/agent/cloud-workspaces.json`. CLI, SDK defaults and Dashboard mapping storage honor `DREB_CODING_AGENT_DIR`; the SDK can explicitly select `agentDir`. Dashboard pairing storage is separate and is not redirected by this mapping choice. The browser cannot select an agent directory. Registry mappings are not merged project/global settings and add no new preference keys. The separate, explicitly confirmed log configuration updates only the existing global `sessionDir` and `subagentSessionDir` fields in that agent directory's `settings.json`; mapping operations do not change them.

Version 1 registry shape (the paths and IDs below are illustrative):

```json
{
  "version": 1,
  "workspaces": [
    {"id": "11111111-1111-4111-8111-111111111111", "path": "/Users/alex/SharedWork"}
  ],
  "projects": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "location": {
        "kind": "workspace",
        "workspaceId": "11111111-1111-4111-8111-111111111111",
        "relativePath": "widget"
      },
      "markerRequired": true
    },
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "location": {"kind": "local", "path": "/Users/alex/src/private-widget"},
      "markerRequired": false
    }
  ]
}
```

A workspace binding is `{id, path}`. A project binding is `{id, location, markerRequired}`, with either `{kind: "local", path}` or `{kind: "workspace", workspaceId, relativePath}` as its location. Relative paths use portable `/` separators (`.` means the root itself); absolute paths and traversal are rejected. Canonical local folder/permission checks and containment validation prevent workspace-relative projects from escaping their root, including through symlinks.

**Never sync the registry or the entire agent directory.** Keep machine settings, trust policy, and authentication local; selecting an agent-directory override does not make it portable. See [Settings](settings.md#cloud-workspace-registry).

## SDK API

Import `CloudWorkspaceRegistry`, `CloudSessionStorage`, `CloudWorkspaceError`, `getCloudWorkspaceRegistryPath`, and associated types from the narrow public `@dreb/coding-agent/cloud-workspaces` subpath. It exposes the metadata registry, global session-storage helper, errors/types, version constant and registry-path helper without importing the agent/session/provider/UI runtime barrel. Existing `@dreb/coding-agent` root exports remain compatible; no root-barrel runtime export is added for `CloudSessionStorage`.

```typescript
import { CloudWorkspaceRegistry } from "@dreb/coding-agent/cloud-workspaces";

const registry = new CloudWorkspaceRegistry({ agentDir: "/native/absolute/local-agent-dir" });
// Or new CloudWorkspaceRegistry() for the default agent directory.
```

`registry.path` is the registry file path string; `getCloudWorkspaceRegistryPath(agentDir?)` also returns that path. SDK `connect` and `link` require **native absolute directories**, unlike CLI relative-path/tilde handling.

| Async method | Return type |
|---|---|
| `list()` | `Promise<CloudWorkspaceState>` |
| `connect(directory, {initialize?, rebind?, expectedId?}?)` | `Promise<CloudWorkspaceBinding>` |
| `link(directory, {initialize?, rebind?, expectedId?, projectId?, workspaceId?}?)` | `Promise<CloudProjectBinding>` |
| `resolve(projectId)` | `Promise<string>` |
| `status()` | `Promise<CloudWorkspaceStatus>` |
| `unlink(projectId)` | `Promise<boolean>` |
| `disconnect(workspaceId)` | `Promise<boolean>` |

Optional SDK `expectedId` is a same-identity precondition, validated as a full UUID and normalized to lowercase. It rejects a different identity before marker/registry mutation and cannot be combined with `initialize: true`. It does not authorize markerless linking: use explicit `projectId` for that, and supply the same ID if both options are present. Dashboard row rebinds use this guard; it is **not a new CLI flag**. Existing CLI and markerless known-ID semantics remain unchanged.

`CloudWorkspaceStatus` is `{version: 1, workspaces, projects}` with per-record `{id, available, path?, error?: {code, message}}`. Errors expose `CloudWorkspaceError.code` and `.message`. Marker and registry versions are both 1; this is independent of the session-file version.

The subpath also exports `CloudSessionStorage` and the `CloudSessionDirectories` / `CloudSessionStorageStatus` types:

- `new CloudSessionStorage({agentDir?, baseCwd?, activeSessionDir?})` selects host-local `settings.json` using the same default/profile agent-directory convention (`DREB_CODING_AGENT_DIR` unless `agentDir` is supplied). `baseCwd` defaults to `process.cwd()` for resolving existing relative main-root settings. `activeSessionDir` is the actual startup-snapshotted global main inventory root, or omitted for the built-in inventory.
- `read(): Promise<CloudSessionStorageStatus>` reads only global storage metadata; it does not create settings, log directories or a registry.
- `setRoot(root: string | null, expected: CloudSessionDirectories): Promise<CloudSessionStorageStatus>` validates a native absolute existing root and saves its two derived paths, or removes only the two fields for `null`. `expected` must match the fresh pair under `settings.json.lock`; a stale pair raises `CloudWorkspaceError` with code `CONFLICT`. Unrelated settings are preserved and malformed/nonregular metadata is not overwritten.

`CloudSessionDirectories` is `{sessionDir: string | null, subagentSessionDir: string | null}`: the current stored values, with absent fields represented as `null`. `CloudSessionStorageStatus` adds `subdirectories: {sessionDir: string, subagentSessionDir: string}` (normally `.dreb/sessions` and `.dreb/subagent-sessions`, following `CONFIG_DIR_NAME`) and `restartRequired: boolean`. Restart status compares the configured main root resolved against `baseCwd` with the supplied active snapshot; it does not track subagent-root changes or restart a process. The helper loads no project settings/context, trust, providers or transcripts, and has the same no-migration/no-active-session-change limits as the UI.

See the [metadata-only registry SDK usage](sdk.md#cloud-workspace-registry) and [SDK example](../examples/sdk/13-cloud-workspaces.ts). Callers may explicitly pass a resolved CWD to the existing SDK; resolution itself neither creates nor resumes an agent session.

## Errors, repair, and removal

- **Missing or unavailable folder:** restore/download the intended existing directory and marker, check permissions, then retry. `list` can still show the configured binding; use `status` to check it.
- **Missing required marker:** wait for or restore the original marker. Do not use `--init` as a repair shortcut on another offline device. An intentionally marker-free local project can instead use its known ID explicitly.
- **Invalid, future, or conflicting metadata:** inspect the reported file and restore the intended supported metadata from a trusted copy. It is never automatically overwritten or reset. `--rebind` changes a local mapping, not a marker's identity or validity.
- **Moved directory or changed binding:** use `connect ... --rebind` or `link ... --rebind` after checking the destination and identity. A different identity already registered at the destination is a conflict, not an implicit replacement.
- **Partial initialization:** if a marker was created but local registration failed, `PARTIAL_INITIALIZATION` reports that the marker was preserved. Fix the local error and retry using the existing identity.
- **I/O or lock failure:** inspect the diagnostic and local permissions/state before retrying; do not assume a failed operation reset or removed metadata.

`unlink PROJECT_UUID` and `disconnect WORKSPACE_UUID` are idempotent: repeated removal succeeds with `removed: false` when already absent. They delete only device-local bindings, never markers, folders, content, or sessions. Disconnect retains dependent project IDs; those projects remain unavailable until that workspace is reconnected.

Local locks and atomic registry replacements protect cooperating local CLI/SDK updates only. They do not guarantee cloud ordering, delivery, or safe independent initialization across offline devices.

## Compatibility and limits

This is partial delivery of [issue #564](https://github.com/aebrer/dreb/issues/564), which remains open for the broader portability work.

- Existing [`sessionDir` and `subagentSessionDir`](settings.md#sessions) precedence, exact transcript paths, historical headers/CWDs, session/RPC formats and trust policy remain separate from registry mappings. Dashboard offers explicit linked-ID directory selection, not automatic remapping. See [Session format](session.md#cloud-workspace-compatibility) and [Dashboard compatibility](dashboard.md#cloud-workspace-compatibility).
- There is no `/cloud` slash command. Persistent main/subagent project association and automatic mapping-aware resume are not delivered.
- Portable parent/child reconciliation, full-history checkpoints/continuations and safe cross-device handoff remain future work. OneDrive or another client transports files; it is not a distributed lock, process migration or checkpoint guarantee. No concurrent live-JSONL writer safety is added.
- There is no provider OAuth/API integration, sync `.gitignore` enforcement, forced migration, or global-install change. This documentation makes no real OneDrive, Google Drive, or second-OS certification claim.
