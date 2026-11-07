# Cloud Workspaces

Cloud workspaces are a provider-neutral identity registry, CLI, and SDK foundation for mapping the same project ID to different existing local folders on different computers. This initial Phase 1A slice is **metadata only**, not full session portability or a sync service.

Use folders you already manage, including folders delivered by a desktop sync client. dreb makes no provider OAuth, provider API, or network calls directly. A desktop client may transfer the metadata you explicitly request; dreb does not verify that delivery.

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

`WORKSPACE_UUID` and `PROJECT_UUID` throughout these commands are placeholders: replace them with the distinct full UUIDs returned by `connect` and `link`. Project IDs are not workspace IDs; partial UUIDs are not accepted.

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

Each computer keeps its own registry. Shared markers carry identity, not either computer's paths. Connecting the root does not discover or register every project: explicitly link each project once per device. There is no basename guessing, home/drive scan, or eager transcript hydration.

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

The **device-local** registry is `<agent-dir>/cloud-workspaces.json`, normally `~/.dreb/agent/cloud-workspaces.json`. It honors `DREB_CODING_AGENT_DIR`; the SDK can explicitly select `agentDir`. There are no new `settings.json` options or merged project/global settings for this registry.

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

Import `CloudWorkspaceRegistry`, `CloudWorkspaceError`, `getCloudWorkspaceRegistryPath`, and the associated types from `@dreb/coding-agent`.

```typescript
const registry = new CloudWorkspaceRegistry({ agentDir: "/native/absolute/local-agent-dir" });
// Or new CloudWorkspaceRegistry() for the default agent directory.
```

`registry.path` is the registry file path string; `getCloudWorkspaceRegistryPath(agentDir?)` also returns that path. SDK `connect` and `link` require **native absolute directories**, unlike CLI relative-path/tilde handling.

| Async method | Return type |
|---|---|
| `list()` | `Promise<CloudWorkspaceState>` |
| `connect(directory, {initialize?, rebind?}?)` | `Promise<CloudWorkspaceBinding>` |
| `link(directory, {initialize?, rebind?, projectId?, workspaceId?}?)` | `Promise<CloudProjectBinding>` |
| `resolve(projectId)` | `Promise<string>` |
| `status()` | `Promise<CloudWorkspaceStatus>` |
| `unlink(projectId)` | `Promise<boolean>` |
| `disconnect(workspaceId)` | `Promise<boolean>` |

`CloudWorkspaceStatus` is `{version: 1, workspaces, projects}` with per-record `{id, available, path?, error?: {code, message}}`. Errors expose `CloudWorkspaceError.code` and `.message`. Marker and registry versions are both 1; this is independent of the session-file version.

See the [metadata-only SDK usage](sdk.md#cloud-workspace-registry) and [SDK example](../examples/sdk/13-cloud-workspaces.ts). Callers may explicitly pass a resolved CWD to the existing SDK; resolution itself neither creates nor resumes an agent session.

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

- Existing [`sessionDir` and `subagentSessionDir`](settings.md#sessions), historical CWDs, exact-path actions, Dashboard/RPC/resume behavior, trust grants, and agent configuration are unchanged. Registry mappings do not automatically remap sessions. See [Session format](session.md#cloud-workspace-compatibility) and [Dashboard compatibility](dashboard.md#cloud-workspace-compatibility).
- There is no `/cloud` slash command or Dashboard Cloud page. Main/subagent project association and automatic project-aware resume are future slices.
- Full-history immutable checkpoints and continuations belong to a future phase. This foundation adds no concurrent live-JSONL writer safety or process migration.
- There is no provider OAuth/API integration, sync `.gitignore` enforcement, forced migration, or global-install change. This documentation makes no real OneDrive, Google Drive, or second-OS certification claim.
