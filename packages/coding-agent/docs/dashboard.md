# Web Dashboard

`dreb dashboard` launches a browser UI for dreb: a fleet overview of sessions
across projects, a full-parity chat view, live background-subagent
observability, host file browsing, and settings — usable from desktop and
mobile browsers.

The dashboard lives in the `@dreb/dashboard` package. Live agent control goes
over [RPC mode](rpc.md): the server maintains a pool of `dreb --mode rpc`
child processes, one per live session. The server uses dreb's public session
APIs for on-disk inventory/delete and serves its own host file API.

## Memories

The Memories tab keeps the global dreb scope visible and lists only populated project `.dreb/memory` directories discovered from active and on-disk sessions. Empty or missing project scopes are omitted because the dashboard edits and deletes existing documents but does not create entries. The complete `MEMORY.md` index and direct-child entries are editable with revision conflicts, sanitized previews, and synchronized index cleanup on delete. Local direct-child links in the rendered index open the entry within the current scope; external links retain normal safe link behavior. Scope and document changes immediately hide stale editor content and show loading feedback while fresh data is read.

## Launching

```bash
# via the dreb CLI (requires @dreb/dashboard to be installed)
dreb dashboard [--port 5343]

# or directly
dreb-dashboard [--port 5343]

# remote over Tailscale with HTTPS (PWA + notifications on mobile)
dreb dashboard --remote --allow you@example.com \
  --https --cert /path/cert.pem --key /path/key.pem
```

If `@dreb/dashboard` is not installed, `dreb dashboard` fails loudly with
install instructions (`npm install -g @dreb/dashboard`).

Open `http://127.0.0.1:5343` on the same machine.

## Local vs remote — exactly two modes

**Local-only (default).** The server binds `127.0.0.1` exclusively. Machines
on your LAN cannot reach it — packets never arrive at the process. No login or
pairing. Works without Tailscale installed. This is the right mode for
same-machine use, including work environments.

Requests are additionally validated for loopback `Host`/`Origin` headers, so a
malicious website cannot drive the dashboard API through DNS rebinding.

**Remote (opt-in).** For any access from another device — phone, laptop, even
on the same LAN — the path is [Tailscale](https://tailscale.com):

```bash
dreb dashboard --remote --allow you@example.com --allow teammate@example.com
# or: dreb-dashboard --remote --allow you@example.com --allow teammate@example.com
```

Layers, in order, all fail-closed (any auth-subsystem error denies):

1. **Tailscale reachability** — the peer address must resolve through the
   peer-specific `tailscale whois --json` command. Concurrent requests for the
   same normalized peer share one in-flight lookup; completed identities are not
   cached. A clean unknown peer remains a 403, while command, timeout, and parse
   failures remain fail-closed as distinct auth-subsystem errors. No Tailscale,
   no access.
2. **Identity allowlist** — `--allow` login names. An empty allowlist denies
   everyone. Rejected identities see a denial page naming the identity.
3. **Pairing code** — first login from a new device requires the current
   6-digit rotating code. The code is shown live in settings → devices on the
   host/local dashboard and rotates every 30 seconds (the current code is also
   printed at server start as a headless fallback). It proves the person can
   see the host machine's local dashboard, so a stolen allowlist identity can't
   quietly gain access.
4. **Device cookie** — successful pairing sets a signed HttpOnly cookie. New
   pairings last 180 days by default; settings → devices accepts a whole-day
   lifetime from 1 through 3650 for future pairings. Existing devices retain
   their recorded `expiresAt`. When a remote device has at most 10% of its
   original validity remaining (and has not expired), it receives an advance
   warning at most once per UTC day across tabs, reconnects, and dashboard
   restarts. Paired devices show their expiry date and can be unpaired at any
   time.

**There is no LAN mode.** The server never listens on a LAN-reachable
interface without Tailscale identity enforcement.

### What a paired device can do

Pairing grants the same power as sitting at the terminal: chatting with
agents, running commands through them, browsing the whole host filesystem
(anywhere the dreb process can read), and uploading/downloading files. The
pairing screen states this before the PIN is entered. Every file operation is
logged server-side.

## WSL2 gotcha — intermittent "access denied" / pairing screen on localhost

<a id="wsl2-gotcha"></a>

If you run the dashboard inside **WSL2** and reach it from a Windows browser at
`http://127.0.0.1:5343`, you may intermittently get an **access-denied /
pairing screen even in local mode** — typically right after the WSL VM has been
idle, clearing once WSL is "warm" again (e.g. after you open a WSL terminal,
which is itself slow to start because the VM is resuming).

**Cause.** With WSL's `networkingMode=mirrored`, host→guest loopback traffic can
reach the server with a source address of `10.255.255.254` — the mirrored
host-loopback address WSL assigns to `lo` — instead of `127.0.0.1`, during the
window after a cold boot / resume before the loopback relay settles. Local-mode
auth only treats `127.x.x.x`/`::1` as loopback, so those requests fail the
loopback check and are denied; the client renders that denial as the
access-denied / pairing screen. No actual Tailscale/pairing is involved.

**Why it correlates with WSL idling.** WSL tears the VM down when idle, and a
dashboard running as a background service does **not** keep it alive: WSL's
instance watchdog only counts processes it launches directly (interactive
`wsl.exe` sessions or `wsl --exec`), and a `systemd`-managed service lives under
PID 1 where the watchdog never sees it. So an always-on dashboard still lets the
VM idle out, and the first request after resume can land in the transitional
networking window above.

**Workarounds** (host-side — no dreb changes needed):

- **Keep a WSL terminal open.** Simplest and most reliable: an attached
  interactive session is exactly the signal WSL uses to keep the VM alive, which
  also avoids the post-resume networking window entirely.
- **Headless keep-alive.** Run `wsl --exec dbus-launch true` (e.g. as a logon
  Scheduled Task): it leaves a lingering background daemon that holds the VM open
  with no terminal window. Re-run after each Windows reboot — it does not
  persist. See [microsoft/WSL#10138](https://github.com/microsoft/WSL/issues/10138).
  A `sleep infinity` session via Task Scheduler works too. (`vmIdleTimeout=-1`
  in `.wslconfig` is Windows-11-only and reported unreliable for keeping the
  *instance* — not just the VM — alive.)
- **Access via the WSL VM's own IP** instead of localhost, if that path is
  loopback-clean for your setup.

## Screens

| Screen | What it does |
|---|---|
| **Fleet** | Home. Live-first: one grid of every live session at the top — status chip (● running / ◆ needs-attention / ○ idle / ✕ error), project path, activity line, live subagent lines, tasks progress, ctx%, model, terminal provider-error reason, last activity. Live cards keep a deterministic order by project path, then session start time; needs-attention cards badge the browser tab without jumping around. Below the grid: past sessions grouped by project, three compact rows per group with an "all N on disk" expander, resume and delete. |
| **Session view** | Full chat drill-in. Markdown streaming transcript (text, thinking blocks with expand preference, inline provider/API failures with partial output preserved, agent-result cards, tool cards with bespoke read/write/edit/bash bodies plus full expandable inputs, markdown-rendered results for markdown-contract tools like subagent/skill/web_fetch/suggest_next, and inline tool-result images, compaction/branch summaries, custom messages), per-message copy, tasks panel, a bounded scrollable subagent panel that lists every retained agent newest-first with full running/done counts, a shared dismissible banner region for model fallback, extension notices, retry/compaction/paused/provider status, and local action results, a controls-only dock line with elapsed time plus ■ stop and explicitly labelled retry/compaction aborts, a persistent session-header live indicator, and an info bar with cwd, branch, session name, token breakdown, cost/(sub)/daily rollup, ctx%, a TUI-parity latest-100 median TPS indicator (`~31 tok/s [100] · 10% ↑ median [10000]`), and a stats popover. Composer supports auto-grow, history, `/` autocomplete from `get_commands`, image attach/paste with sent images retained as user-message previews, queued-message chips with restore-all, steer/follow-up modes, and suggest-next. Registered built-in slash commands are discovered generically, deduplicated ahead of colliding resource commands, and intercepted before prompting: dashboard actions cover settings, model, scoped-models, export/import, name/session stats, fork/tree, new/compact/dream, resume/reload, and quit. `/scoped-models` deep-links to the Settings editor with the session's current cwd as project context; login/logout show an explicit not-yet-implemented notice, while copy/hotkeys/buddy give terminal-only guidance. Future built-ins are intercepted automatically. The RPC prompt boundary rejects any built-in that reaches it during command-loading races or failures, so slash text cannot leak to the model. Attachments are retained and the command is visibly rejected rather than silently discarded. The ⋯ menu covers export HTML, compact, rename, fork-from-message, loaded context, and tool expand/collapse. Session names update live from manual rename or auto-naming. Extension UI requests for select/confirm/input/editor render as modals; a rich `ask`/`ask_user` request renders inline as a single wizard that presents all its questions together — each with Markdown-formatted question text, choices, optional free text — plus an in-card Stop agent action, Escape-to-stop, and the authoritative auto-stop countdown, and is answered as one batch submit. Pending questions set needs-attention state and use the existing hidden-page notification path. Extension notifications for the viewed session render in its banner region; other sessions' and app-global notices use the fixed top-center toast stack. |
| **Subagent view** | Transcript of a background agent: live events via the RPC relay, hydrated from the agent's on-disk session log (`/subagents/:agentId/messages`) so the transcript survives browser reloads. Shows the task, streaming output, tool activity, and any safe Dispatch Arbiter changed/unchanged/failure records with the final agent/model/thinking. No raw arbiter output is displayed or transported. While the child is running, a composer sends the user's text unchanged to that specific child as steering input, displays its pending steering queue, and reports its effective `one-at-a-time` or `all` delivery mode. Completed, failed, rehydrated, and unavailable children remain read-only. |
| **Files** | Host-wide browser with places shortcuts (home, /tmp, project roots), breadcrumbs to `/`, new-folder, download, drop-zone/picker upload with explicit collision prompts, and "new session here" on any directory. It also shows the **effective global nested-context trust** for the displayed canonical directory: untrusted, trusted by that root, inherited from a granting root, or global expert trust-all. You can trust the displayed folder and descendants, or untrust the actual granting root; untrusting an inherited folder removes that root's trust for all descendants. |
| **Memories** | Dreb-only memory management for `~/.dreb/memory` and `.dreb/memory` under active/disk project roots. It lists existing `MEMORY.md` indexes and direct child `.md` entries only (no Claude paths, create, or rename), shows entry frontmatter or metadata errors so malformed files can be repaired, renders sanitized Markdown preview beside a raw editor, and uses exact SHA-256 revisions so stale saves/deletes return conflicts while preserving drafts. The index view is complete, not truncated, and warns when it exceeds the 200-line memory-index convention. Entry deletion requires both entry and index revisions, removes only matching safe Markdown-link index lines (`file.md` / `./file.md`), writes the cleaned index atomically before unlinking the entry, and rolls back loudly if the unlink fails. |
| **Settings** | Persistent defaults (default model, thinking level, steering/follow-up queue modes, auto-compaction, opt-in continuation after every successful automatic compaction, auto-retry) via `get_settings`/`set_settings` — validation errors are shown verbatim. The continuation option is off by default, can keep unattended model turns and costs running indefinitely, and never affects manual `/compact`. The tab-title card exposes the default-enabled generator toggle and an exact authenticated `provider/model` picker; an unset model clearly retains Explore-agent routing, a pinned model can be cleared back to that route, and edits apply to new unnamed sessions. The scoped-models editor controls model cycling for new sessions only: grouped search, model/provider/all toggles, responsive controls, accessible up/down partial-scope ordering, and save/reset. An absent `enabledModels` is future-inclusive all models in registry order and cannot be reordered; a partial scope is a non-empty ordered list of canonical `provider/model` references. Editing legacy glob, fuzzy, or thinking-suffix values saves normalized exact references. The selected context reads effective global + project settings but writes global; a project-level `enabledModels` shadow is warned. The global-only Dispatch Arbiter card exposes enable/disable, exact authenticated model selection, thinking, guide path, and readiness guidance; model-less enablement is blocked and RPC/runtime validation remains fail-closed. Entering Settings flushes pending writes and reloads durable global + project settings, so external edits appear; read, parse, or write failures fail loudly instead of showing stale settings. The global-only nested-context policy lists every explicit trusted root for audit and revoke, offers a simple add-by-path control, and includes a prominently warned expert trust-all toggle; the Files view remains the primary place to grant trust while browsing. Most defaults seed new sessions, including **Max concurrent subagents** (default 4). Setting it to 0 starts new parents without the subagent tool and tells the parent model to perform normally delegated work itself; positive values cap running children per parent session. Context-trust changes are observed by active main/subagent processes for future lazy loads, but cannot remove already injected content. Dashboard-local preferences (always expand thinking, transcript image display mode, needs-attention notification permission) live in the browser, alongside an appearance section: a theme gallery of eight curated themes (entropist.ca, Dim, Solarized, Gruvbox, Caves of Qud, Van Gogh, and the colorblind-safe Okabe-Ito and Paul Tol) with live preview cards plus system/light/dark mode and Theme default/IBM Plex Mono/JetBrains Mono/Fira Code/Iosevka/OpenDyslexic/Atkinson Hyperlegible font selectors, saved per browser. Shows the current rotating pairing code on the host/local dashboard, the 1–3650 day lifetime used only for future pairings (180-day default), and paired-device expiry dates with unpair. |
| **Pairing** | Remote first-login: identity echo, rotating-code entry, and the security copy explaining what pairing grants. |

### Notifications and explicit navigation

The session banner region is the single surface for notices belonging to the
session being viewed. Each banner has its own dismiss control, persists until
dismissed or cleared by its source lifecycle, and caps long text with internal
scrolling so its controls remain reachable on mobile. Dismissing a status banner
is presentation-only: provider/error state, Fleet needs-attention state, tab
badges, and hidden-page notifications remain accurate until the underlying
runtime reports recovery. Genuinely app-global notices and extension notices
from other sessions use a separate fixed top-center toast stack. Runtime closure
never creates a redundant Fleet toast.

The dashboard does not move the user automatically after creating or closing a
session. Fleet and Files session creation stays on the current screen; the new
runtime appears in Fleet. If the runtime behind an open main-session or
subagent page closes, that page retains its browser-held transcript as a
read-only snapshot with **Resume session** (when an exact session path was
captured) and **Return to fleet** actions. It is not a live runtime: composers,
steering, model/thinking controls, stop controls, polling, and other runtime
actions are disabled. Leaving that session's main/subagent route family releases
the retained snapshot; Fleet shows no live card, and the authoritative on-disk
session remains in its project group for normal resume.

### Dispatch Arbiter observability

When the global Dispatch Arbiter is enabled, the dashboard consumes the typed `subagent_arbitration` RPC event. The matching background-agent card is updated to the final selected agent before child events arrive; the parent panel row shows final model/thinking or a failure marker, and the subagent drill-in lists ordered records (including chain steps). Runtime snapshots carry the same safe records so refresh/resync during a live process does not revert to the requested identity.

Only host-validated proposed/final tuples, changed fields, status, step, and bounded host errors cross RPC/SSE. Arbiter prompts, raw output, reasoning, tasks, guides, and parent excerpts never reach dashboard protocol state. The safe record is separately persisted in the parent session as a non-context custom entry; child transcript hydration remains sourced from the child log.

### Transcript images

Tool results containing PNG, JPEG, GIF, or WebP image blocks are available in
any tool card, not only `read`. Images uploaded with a user turn also remain
visible as previews in that transcript entry after sending. This human-facing
rendering is independent of model vision support: a text-only model can omit a
tool image from its own context while the dashboard still shows it. At the dashboard-server projection boundary,
exact base64, an exact raster MIME allowlist, and matching byte signatures are
required. SVG, malformed payloads, and MIME/signature mismatches are rejected.
Accepted originals are content-addressed from the exact MIME type and decoded
bytes, then browser-facing live events, replay, hydrate/resync, parent messages,
and subagent messages carry only an ID, MIME type, and original binary size.
Authoritative RPC/session history is not changed.

In dashboard mode the child applies the same reduction one boundary earlier,
before JSONL serialization: each unique image (exact MIME type plus decoded
bytes) crosses the child stdout pipe at most once per child process lifetime,
and every later occurrence — prompt re-emission, each tool-result re-delivery,
the `agent_end` transcript — becomes the small `image_reference` frame the
dashboard already understands. The dashboard's image cache holds the binary
from the first-occurrence event, so references resolve without the slow
authoritative reload. The child turns a block into a reference only when this
strict decode accepts it (allowlisted MIME type, canonical base64, matching
byte signature); anything it would reject stays inline at every occurrence and
is dropped exactly as before — never becoming an unresolvable reference.
Command responses (`get_messages`, `get_dashboard_snapshot`) always carry full
payloads because they are the authoritative source image recovery reads.

The browser-local `dreb.dashboard.imageDisplayMode` setting has three modes:

- **placeholders** — assign no image `src` and make no request until preview or
  original loading is explicit;
- **bounded previews** (default) — lazily request a preview no larger than
  **1024 × 1024** or **256 KiB**. Clicking opens an accessible lightbox that
  reuses the same preview URL and does not fetch the original;
- **automatic originals** — load only originals for mounted images. Selecting
  this in Settings is the informed network-data opt-in.

Every non-original view labels the original binary size. Explicit originals
above **1 MiB** require confirmation before any original URL is assigned.
These dashboard display choices are separate from `images.autoResize` and
`images.blockImages`, which control images sent as model input. GIF previews
are static first-frame PNG/JPEG encodings; the original route preserves the
exact animated GIF bytes.

Preview/original routes are authenticated, same-origin, content-addressed, and
return an exact allowlisted `Content-Type`, `Content-Length`,
`X-Content-Type-Options: nosniff`, and private immutable caching. Originals and
previews share a **64 MiB / 2,000-record LRU** and duplicate transcript copies
deduplicate. Preview generation is lazy, single-flight, and worker-backed, so
resize work does not block ordered SSE publication. After eviction or server
restart, a request scans only the referenced parent transcript or registered
subagent log, recomputes the ID, and repopulates the cache; unavailable
transient images fail explicitly rather than substituting other bytes. Runtime
removal revokes its scopes.

Image bytes never enter browser-facing SSE frames, so image size alone cannot
cause `oversized_event` or consume replay history. HTML export still reads the
unchanged authoritative session data, applies its raster sanitization, and
embeds full-resolution originals in a self-contained transcript.

### Provider failures and retries

Assistant messages finalized with `stopReason: "error"` keep their provider
error metadata in the transcript. The dashboard renders a text-labelled `Error:
<message>` line after any nonblank partial thinking or text, so the failure does
not rely on color alone. A finalized whitespace-only thinking block is omitted
instead of leaving an empty details box. Missing or blank error text uses
`Unknown error`; `stopReason: "aborted"` remains a separate outcome.

Per-attempt failures are historical facts. They survive ordinary hydration,
subagent drill-in, and resync even when a later retry succeeds. Current terminal
state is derived separately: only the latest assistant error on an idle runtime
sets the session error status, needs-attention state, and fleet card error
reason. Active work and a later successful assistant response clear stale
terminal state.

A provider-error `message_end` initially appears terminal because retryability is
decided immediately afterward. When `auto_retry_start` arrives, the session and
fleet terminal error clear and the existing retry warning takes over; the failed
attempt remains inline. Authoritative hydration and resync snapshots carry retry
activity explicitly, so a refresh during backoff restores that warning and the
persisted failed attempt without reclassifying it as terminal. A successful
retry stays clear. Disabled retry, non-retryable errors, and exhausted retry
remain terminal, and exhausted retry upserts the same status instead of
duplicating it.

## Fleet transport and freshness

A normal dashboard load makes one authoritative `GET /api/fleet`; the fleet is
also included in the ordered `/api/resync` response only during exceptional
recovery. After initial load, global event-derived `fleet_snapshot` SSE frames
update live runtime cards. The runtime pool emits those frames with a 200 ms
debounce from its in-memory state, so an update performs neither child RPC calls
nor a disk inventory scan.

Live runtime state and on-disk session inventory have separate refresh paths.
Before fleet, inventory, or resync serialization, the server explicitly projects
each on-disk session to the declared browser DTO and bounds its first-message
preview to 256 Unicode characters. Internal parent paths and complete searchable
transcript text never cross this browser boundary. After creating, resuming,
stopping, or deleting a session, the client narrowly refreshes the disk list
through `GET /api/sessions` rather than reloading the whole fleet. While the
Fleet screen is visible, it polls each live runtime's
stats no more often than every 30 seconds. That poll is single-flight, retains a
card's last good stats if an update fails, and surfaces failures in the Fleet UI.

For the activity preview, a card prefers the newest assistant text derived from
its hydrated client transcript entries. Until those entries exist, the
authoritative initial-load or resync fleet preview is the fallback. `ctx%` is
never estimated in the browser: it comes from authoritative session state or
stats. Immediately after compaction, the session reports a conservative estimate
over its rebuilt message context until fresh provider usage becomes available.
Live card ordering remains deterministic by project path and then session start
time, not mutable activity.

A session drill-in hydrates through one `GET /api/runtimes/:key/hydrate` request.
The server backs it with one `getDashboardSnapshot` RPC call and its matching
barrier, rather than three independently timed state/message/background-agent
calls. While mounted, the view applies periodic, turn-end, and compaction-end
authoritative detail refreshes to its header and the shared runtime. Successful
model/thinking mutations update the pool's snapshot state; the client protects
their confirmed values from older in-flight frames only until the matching
sequenced snapshot arrives, after which later authoritative changes flow
normally. Replay and resync retain their ordering guarantees below.

## Live connection and recovery

The top bar and persistent session header expose the live-stream state as an accessible text `output`, not color alone: **connecting**, **connected**, **retrying** (including its delay), **resyncing**, **disconnected**, or **auth failed**. The session-header indicator remains visible when the session details or composer controls are collapsed. This is the state of the dashboard's single SSE connection, not the state of an individual agent.

Events are `{seq, key, event}` envelopes. The server retains a **projected** form of reducer-relevant events in a ring bounded by both entry count and encoded bytes; a reconnect can replay only a separately byte-bounded range. Projection removes cumulative fields the browser reducer does not use, rather than silently truncating an event. If history is too old or the requested replay exceeds budget, only that reconnect receives a `dashboard_resync` barrier at the current cursor; healthy browsers are not interrupted. A projected event whose **non-image content** is itself oversized emits a global barrier because every browser missed it; image blocks have already become small references before frame sizing. A slow client's write buffer is bounded too: backpressure closes that SSE connection, then the normal recovery path takes over. The RPC child side is bounded as well: its stdout write queue may accumulate past **16 MiB** while a slow-but-alive consumer keeps making drain progress, and a backlog over **16 MiB** aborts the child only after **30 seconds without drain progress**, so a briefly stalled dashboard consumer survives multi-image bursts instead of losing the session.

On a barrier, protocol error, reducer error, server restart, sequence gap, or stalled stream, the browser fetches the authoritative `/api/resync` snapshot. For an active runtime, its state (including the atomically replaced task list), transcript, and background-agent registry are paired with the EventHub sequence captured synchronously at the RPC snapshot marker. The HTTP response carries that `barrierSeq`; the browser discards queued envelopes through it, then applies strictly later envelopes. A viewed subagent transcript has its own earlier disk-read boundary so relays between the disk and parent snapshot are also restored. This ordering prevents duplicate or missing transcript/task changes and restores tasks after a hard refresh or recovery gap. The barrier is an ordering contract, not a timing delay; see [Dashboard snapshots](rpc.md#get_dashboard_snapshot).

The server sends a named, unnumbered `heartbeat` SSE event every **25 seconds**. While the page is visible, a **60-second** liveness watchdog recovers a stream that stops delivering heartbeats or application envelopes. Retries are owned by the client (native EventSource retries are closed first): capped exponential backoff reaches at most **30 seconds**, with ±25% jitter, and its attempt count resets only after **60 seconds of healthy liveness**, not merely after opening the socket. On every return to the foreground, the browser validates dashboard auth before trusting or recovering the stream. Validation is aborted after **10 seconds** so a black-holed request cannot stall recovery; a 401/403 becomes **auth failed**, while timeouts and other validation failures recover normally.

For optional troubleshooting, the stream first supplies an opaque connection ID. The browser may send a correlated diagnostic summary only to the dashboard-authenticated endpoint. It contains connection metadata and counters only—never prompts, cookies, event payloads, or tool data—is schema-checked, capped at **4 KiB**, and rate-limited once per connection every 30 seconds. Server logs explicitly project the same metadata, so diagnostics remain useful without becoming a content side channel.

### Nested context trust

The Files controls govern only **lazy nested/out-of-cwd** context loading, not the separate initial upward scan that dreb performs from a session's launch cwd. The initial scan is always part of startup; do not treat the Files trust badge as a way to disable or redefine it.

By default, lazy loading is off. The Files view is the primary grant flow: trust the displayed folder and descendants, or untrust its actual granting root. Settings lists every configured trusted root for audit and revoke, and also offers a simple add-by-path control. Trusting through either screen writes a global root to `~/.dreb/agent/settings.json` (`context.trustedFolders`) and covers that existing canonical directory and descendants. Targets and roots are matched through native `realpath`, so a symlink that escapes a trusted root is untrusted. Project `.dreb/settings.json` cannot enable, disable, or extend nested-context trust; only global settings and the dashboard Files/Settings controls can, so a cloned repository cannot grant itself trust. The global `context.autoLoadNested: true` toggle is an expert trust-all override: it permits every resolvable target and can inject prompt-injection content from untrusted repositories; the UI warns prominently and folder controls cannot narrow it.

The trust state comes from the RPC utility runtime and reports the canonical target, state (`untrusted`, `trusted-root`, or `unrestricted`), and, for inherited access, the canonical granting root. Trust and untrust changes are durable global policy and active main/subagent processes observe them before their next lazy load. They do not remove context already injected into a running conversation. As elsewhere, permitted lazy context is secret-scrubbed, injected after extension `tool_result` transforms, and realpath-deduplicated per session.

### Composer modes

While the agent is streaming, the send button becomes mode-aware:

- **steer** — deliver now: injected into the running turn after the current
  tool call completes.
- **follow-up** — queued; delivered after the agent finishes the current work.
- **■ stop** — abort the current turn. Only visible while streaming.

When the agent is idle, send is a plain prompt.

## Notifications

Needs-attention notifications are delivered through a **service worker**
(`registration.showNotification()`), not the page-context `Notification`
constructor — the constructor was removed from Android Chrome (throws
`Illegal constructor`) and is absent from iOS Safari entirely. The service
worker handles `notificationclick`: it focuses an open dashboard client and
navigates to the session that needs attention, or opens one. All browsers still
get a `◆` tab-title badge fallback when the tab is hidden.

The settings tab exposes a browser-local permission toggle. Gating is unchanged:
notifications fire only when permission is granted **and** the tab is hidden.

**iOS:** notifications exist only in the **installed PWA** (Add to Home Screen,
iOS 16.4+) — a plain Safari tab has no Notification API regardless of HTTPS.
The settings copy explains the install prerequisite when it detects an
un-installed iOS Safari session. (Note: iOS 17.4+ in the EU dropped standalone
PWA support — installed PWAs open as Safari tabs and push is unavailable there.)

## Installable PWA + secure context

The dashboard ships a web app manifest (`display: standalone`, theme/background
colors, icon set), an apple-touch-icon, and service worker registration, so it
is **installable to the home screen** on Android Chrome and iOS Safari 16.4+ —
no URL bar, app-like presence, and (on iOS) the only context where
notifications work.

Service workers and the Notifications API require a **secure context**: HTTPS,
or `localhost`/`127.0.0.1`. Local mode (`http://127.0.0.1:<port>`) already
qualifies — install and notifications work with no TLS setup. **Remote mode
over the tailnet is plain HTTP**, which is not a secure context, so the service
worker will not register and notifications are unavailable until you enable
HTTPS. See [Native TLS](#native-tls-remote-https) below.

## Native TLS (remote HTTPS)

For PWA install + notifications from a phone over the tailnet, the dashboard
terminates TLS itself using certificate files from
[`tailscale cert`](https://tailscale.com/docs/how-to/set-up-https-certificates)
(no reverse proxy, **no auth-model change**):

```bash
dreb dashboard --remote --allow you@example.com \
  --https --cert /etc/dreb/cert.pem --key /etc/dreb/key.pem
```

Because the dashboard terminates TLS directly, `req.socket.remoteAddress` is
still the phone's real tailnet IP — Tailscale identity resolution, the
allowlist, and pairing all keep working exactly as in plain-HTTP remote mode.
There is no header trust, no proxy, no weakening of the auth model.

### One-time cert setup with `tailscale cert`

```bash
# Enable HTTPS certificates in the Tailscale admin console (DNS → HTTPS) first.
sudo tailscale cert \
  --cert-file=/etc/dreb/cert.pem \
  --key-file=/etc/dreb/key.pem \
  hostname.tailXXXX.ts.net
sudo chown dreb:dreb /etc/dreb/cert.pem /etc/dreb/key.pem
sudo chmod 644 /etc/dreb/cert.pem && sudo chmod 600 /etc/dreb/key.pem
```

Renewal is **manual** — `tailscale cert` certs are Let's Encrypt, 90-day
lifetime. The dashboard hot-reloads the cert files on change
(`setSecureContext`), so a renewal that rewrites the files is picked up with
zero downtime. A daily systemd timer with `--min-validity=720h` (only renews
when within 30 days of expiry) is the recommended cadence:

```ini
# /etc/systemd/system/dreb-cert.service
[Service]
Type=oneshot
ExecStart=/usr/bin/tailscale cert --cert-file=/etc/dreb/cert.pem \
  --key-file=/etc/dreb/key.pem --min-validity=720h hostname.tailXXXX.ts.net
ExecStartPost=/bin/chown dreb:dreb /etc/dreb/cert.pem /etc/dreb/key.pem

# /etc/systemd/system/dreb-cert.timer
[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
[Install]
WantedBy=timers.target
```

Then open `https://hostname.tailXXXX.ts.net:<port>` on the phone.

> **Hostname note (important):** the `tailscale cert` certificate is issued
> for your machine's tailnet name (`hostname.tailXXXX.ts.net`) **only** — not
> `127.0.0.1`, not a raw tailnet IP. When `--https` is enabled the server
> speaks TLS on every address it binds, so on the host itself:
>
> - `https://hostname.tailXXXX.ts.net:<port>` — works, cert validates (resolves
>   to your tailnet IP). But it's a *remote* request: you go through the full
>   Tailscale allowlist + pairing flow, not instant loopback local mode.
> - `https://127.0.0.1:<port>` — the server answers, but the browser rejects
>   the cert (no `127.0.0.1` SAN) with a scary warning.
> - `http://127.0.0.1:<port>` — **dead**: the server only speaks TLS now.
>
> If you want the host dashboard tab to stay instant (loopback local mode, no
> pairing, no warning), run a **second** dashboard process without `--https` on
> a different port for local-only use, and keep the TLS-enabled one for remote.
> `--https` is primarily for the `--remote` path; pure-local setups don't need
> it (`127.0.0.1` is already a secure context).

## Subagent observability

Background subagents are first-class:

- Fleet cards show running/done counts and live agent lines.
- The session view shows every retained background agent in a bounded,
  scrollable panel, ordered newest-first with the full running/done count in its
  summary. It uses the same native collapse pattern as the task tracker, starts
  collapsed on mobile, and keeps every row available for transcript drill-in.
- The drill-in view streams the child's events in real time via the
  `background_agent_event` relay (see [RPC events](rpc.md#event-types)) and
  hydrates from the agent's on-disk session log on mount, so transcripts
  survive browser reloads and remain viewable after the agent finishes.

## Responsive behavior

Single breakpoint at 700px. At <=700px, fleet cards stack; long session names,
status chips, project paths, activity and subagent text, and past-session
labels wrap within their cards or rows rather than spilling off-screen. The
session view prioritizes read-and-steer (model/thinking switchers collapse into
⋯, and task/subagent panels default collapsed), and the file table shows name +
download only.
Composer modes, abort, and needs-attention affordances are never reduced away
— steering a running agent from a phone is the primary remote use case.

## Mobile transport profiling

The opt-in profiler runs locally on the dashboard host:

```bash
npm run --workspace @dreb/dashboard profile:mobile -- http://127.0.0.1:5343
```

Its output is aggregate and payload-free: HTTP response sizes/timings plus SSE
sizes, event types, and burst summaries; it does not retain fleet or event
contents. The default capture is 60 seconds. Profile a realistic workload of at
least five live runtimes so both fleet and event behavior are representative.

For browser acceptance, use Chromium's network throttling with 100 ms RTT and
1.5 Mbps. This profile does not emulate HTTP packet loss.

## Architecture

```
Browser dashboard (SolidJS + Vite, tokens.css design system)
  ⇄ Express server: fail-closed auth, REST, SSE fanout, file API
  ⇄ RpcClient pool — one `dreb --mode rpc --ui dashboard` child per session
  ⇄ sessions on disk (~/.dreb/agent/sessions), settings, models
```

- **SSE catch-up**: sequence IDs, count/byte-bounded projected replay, and an
  explicit snapshot barrier form the recovery contract described in [Live
  connection and recovery](#live-connection-and-recovery). Slow clients whose
  server-side write buffer exceeds a bound are disconnected and recover via
  the same path. Deleting a runtime publishes `runtime_removed` so browsers
  evict that session's transcript state.
- **ctx%** comes from the session itself (`get_state.contextUsage` — the same
  numbers the TUI footer shows), never browser-side estimates. The session uses
  rebuilt-message estimation only during the post-compaction gap before fresh
  provider usage exists.
- **Auto-naming** runs in the shared `AgentSession` layer, so dashboard-created
  RPC sessions get the same LLM-generated session names as the TUI and update
  live via `session_name_changed`.
- **Visual language**: `tokens.css` (`packages/dashboard/src/client/styles/`),
  the dashboard's design system, with `themes.css` as an additive layer on top.
  The pristine default (the entropist.ca theme + system mode) renders exactly as
  the `tokens.css` baseline; a curated theme or a forced mode overrides the design
  tokens. See the appearance system below.

## Appearance system

The dashboard owns its own palette surface, deliberately **independent of the
TUI theme system** — dashboard themes intentionally do not map to TUI themes.

- **Curated themes.** Eight themes — entropist.ca (the default baseline), Dim,
  Solarized, Gruvbox, Caves of Qud, Van Gogh, and the colorblind-safe Okabe-Ito
  and Paul Tol palettes — each a *family* with its own light and dark palette.
  The two CVD-safe themes keep running/error on a blue/teal-vs-vermillion/red
  axis (never green-vs-red) so status stays legible under deutan/protan/tritan
  color vision. A separate mode toggle (system / light / dark) picks which
  variant renders; forced light/dark works for every theme, including
  entropist.ca. `system` follows the OS via `prefers-color-scheme`.
- **Theme gallery and font selection.** The settings appearance section shows
  mode and font selectors plus a grid of live preview cards (one per theme).
  Each card previews its palette locally without touching the page until you
  commit by clicking it. Theme default preserves each theme's built-in font;
  IBM Plex Mono, JetBrains Mono, Fira Code (coding ligatures), Iosevka
  (compact, coding ligatures), the bundled dyslexia-friendly OpenDyslexic, and
  the low-vision-friendly Atkinson Hyperlegible can also be selected
  independently. Explicit
  choices are reflected in the previews, while Theme default previews stay on
  IBM Plex Mono so the inactive Gruvbox card does not fetch JetBrains Mono.
- **Per-browser persistence.** Selections are stored in per-browser
  `localStorage` (`dreb.dashboard.theme`, `dreb.dashboard.colorMode`, and
  `dreb.dashboard.font`), with a cross-tab sync listener; a pristine install
  (entropist.ca + system + Theme default font) leaves no keys behind and renders
  byte-for-byte identically to the `tokens.css` baseline. No server/RPC
  involvement, no runtime dependencies.
- **No wrong-appearance flash.** A synchronous bootstrap in `index.html` paints
  the correct theme, mode, and explicit font before any CSS loads, and keeps a
  live `theme-color` meta in sync with the active background.
- **Font loading.** Most themes default to Google-hosted IBM Plex Mono; Gruvbox
  defaults to the bundled self-hosted JetBrains Mono (OFL, provenance in
  `src/client/assets/fonts/`). Fira Code, Iosevka, the dyslexia-friendly
  OpenDyslexic, and the low-vision-friendly Atkinson Hyperlegible are bundled
  self-hosted explicit options (OFL, same directory, one provenance file each),
  and any explicit font selection overrides the theme default. The self-hosted
  families are lazy-loaded only
  when active typography uses them — rendering a theme or its preview card
  never fetches an alternate font. No `light-dark()` is used, keeping an iOS
  Safari 16.4 floor.
- **PWA launch colors.** The static `manifest.webmanifest` keeps white
  (default-light) launch colors as the fallback; the live `theme-color` meta
  follows the active appearance once the app loads.

## Limitations (deliberate, sequenced later)

- No shell passthrough from the browser.
- Completed, failed, rehydrated, and otherwise unavailable subagent transcripts are read-only; only a live controllable child accepts steering.

## Background service / auto-restart

The dashboard runs as a foreground process by default. For it to start on boot
and restart after crashes, run it as a system service.

### Linux (systemd)

Save a user unit to `~/.config/systemd/user/dreb-dashboard.service`:

```ini
[Unit]
Description=dreb web dashboard

[Service]
ExecStart=%h/.npm-global/bin/dreb-dashboard
Restart=on-failure

[Install]
WantedBy=default.target
```

Use the absolute path from `which dreb-dashboard` for `ExecStart` (the example
matches an npm global prefix under `~/.npm-global`). Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dreb-dashboard
```

### macOS (launchd)

Create a **LaunchAgent** (not a LaunchDaemon) — the dashboard must run as the
logged-in user to read `~/.dreb/agent/sessions` and `auth.json`, and to spawn
`dreb --mode rpc` children under that user. A root LaunchDaemon would have the
wrong `HOME` and credentials.

Save a plist to `~/Library/LaunchAgents/com.dreb.dashboard.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dreb.dashboard</string>
    <!--
      Invoke node directly on the resolved entry point. The `dreb-dashboard`
      bin is a #!/usr/bin/env node script; launchd's minimal environment
      cannot resolve `node` via PATH, so we point ProgramArguments at the
      absolute node binary and the resolved dist/index.js.
    -->
    <key>ProgramArguments</key>
    <array>
        <string>/ABSOLUTE/PATH/TO/node</string>
        <string>/ABSOLUTE/PATH/TO/@dreb/dashboard/dist/index.js</string>
        <string>--port</string>
        <string>5343</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- KeepAlive + ThrottleInterval gives crash auto-restart without a tight
         fail-loop. kill -9 the process and launchd respawns it in seconds. -->
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!--
      HOME is set automatically for user agents, so ~/.dreb/agent/auth.json
      (OAuth creds) is found. PATH lets RPC children spawn bash/git/node.
      If you use API keys via shell environment variables rather than OAuth
      creds, add the keys here — LaunchAgents do not source shell profiles.
    -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/YOU/Library/Logs/dreb-dashboard.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOU/Library/Logs/dreb-dashboard.err.log</string>
</dict>
</plist>
```

#### Finding the absolute paths

The two `ProgramArguments` paths vary by install method (Homebrew, nvm, bun
global, npm global prefix). Discover them:

```bash
command -v node                         # → /opt/homebrew/bin/node
realpath "$(command -v dreb-dashboard)"   # → /opt/homebrew/lib/node_modules/@dreb/dashboard/dist/index.js
# If `realpath` is not found, install coreutils: brew install coreutils
```

Replace `/ABSOLUTE/PATH/TO/node` and `/ABSOLUTE/PATH/TO/@dreb/dashboard/dist/index.js`
with the actual output. Also replace `/Users/YOU/` in the log paths with your
home directory.

#### load / unload / status

Use the modern `launchctl bootstrap`/`bootout` API (not the deprecated
`load`/`unload`):

```bash
# load / start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dreb.dashboard.plist
# stop / unload
launchctl bootout gui/$(id -u)/com.dreb.dashboard
# check state
launchctl print gui/$(id -u)/com.dreb.dashboard | grep -E 'state|pid'
```

#### API-key providers

OAuth subscription credentials live in `~/.dreb/agent/auth.json` and are
found via the auto-set `HOME` — no secrets in the plist. If you use API keys
via shell environment variables (e.g. `ANTHROPIC_API_KEY`), add them to the
`EnvironmentVariables` dictionary:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>…</string>
    <key>ANTHROPIC_API_KEY</key>
    <string>sk-ant-…</string>
</dict>
```

LaunchAgents do not source `.zshrc`/`.bashrc`/`.profile`, so env vars must be
set explicitly in the plist.

#### Local vs remote

The plist above runs in local-only mode (binds `127.0.0.1:5343`). For remote
access from a phone, add `--remote --allow you@example.com` to
`ProgramArguments` and see the [remote access walkthrough](#local-vs-remote--exactly-two-modes)
and [TLS setup](#native-tls-remote-https) for the Tailscale + HTTPS path.
Do not expose the port on your LAN — there is no LAN mode.
