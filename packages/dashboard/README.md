# @dreb/dashboard

Web dashboard for [dreb](https://github.com/aebrer/dreb) — a visual, real-time,
mobile-friendly interface for browsing projects and sessions, controlling
multiple dreb agents, watching background subagents live, and using dreb from
devices that are not sitting at the host terminal.

Live agent control goes through RPC: the dashboard spawns `dreb --mode rpc`
child processes (one per live session). The server also uses dreb's public
session APIs for on-disk inventory/delete and serves its own host file API.

## Install & launch

```bash
npm install -g @dreb/dashboard

# local-only (default): binds 127.0.0.1, no auth needed
dreb-dashboard

# If you installed the main dreb CLI (@dreb/coding-agent), the same server is
# also available through:
dreb dashboard

# remote over Tailscale with HTTPS (mobile PWA + notifications)
dreb dashboard --remote --allow you@example.com \
  --https --cert /path/cert.pem --key /path/key.pem
```

Open `http://127.0.0.1:5343`.

## Screens

- **Fleet** (home) — live-first: every live session in one grid at the top
  (stable order by project path, then session start time; each card shows its
  project path, status chip, current activity, live subagents, task progress,
  ctx%, model, cost, last-assistant preview, and terminal provider-error reason). Below, past sessions grouped by project — three
  compact rows each with an "all N on disk" expander — with resume/delete.
  At <=700px, cards stack; long session names, status chips, project paths,
  activity/subagent text, and past-session labels wrap within cards or rows
  rather than spilling off-screen. `+ new session` anywhere.
- **Session view** — full chat parity: markdown streaming transcript, tool
  cards with sanitized inline PNG/JPEG/GIF/WebP result images, thinking blocks,
  inline provider/API failures with partial output preserved, compaction summaries,
  per-message copy, tasks panel, a bounded scrollable panel listing every retained
  subagent newest-first (collapsed by default on mobile), suggest-next chip,
  generic built-in slash-command discovery and fail-closed execution (including
  settings/model/scoped-models, import/export, session tree, fork, new/compact/dream,
  resume/reload, and quit), image attach/paste with sent-image previews retained in user transcript entries,
  queued-message restore, persistent session-header live indicator, footer-parity info bar (branch, tokens, cost, ctx%,
  latest-100 median tok/s with sample count and long-term delta), stats/loaded-context/fork modals, steer/follow-up composer
  modes, ■ abort, model/thinking switchers, extension-UI modals, export HTML,
  and live auto-naming.
- **Subagent drill-in** — transcript of a background agent: live events via
  the relay, hydrated from the agent's on-disk session log so the view survives
  browser reloads. While the child is running, its composer queues user-written
  steering messages directly to that child and shows its effective queue mode;
  completed and rehydrated transcripts remain read-only.
- **Files** — host-wide browse with places shortcuts, upload (collision
  prompts before overwrite), download, new-folder, "new session here", and the
  effective global nested-context trust for the viewed canonical folder. Trust
  the folder and descendants, or untrust the actual granting root (including
  its inherited descendants).
- **Memories** — dreb-only memory management for `~/.dreb/memory` and active
  project `.dreb/memory` scopes. It edits existing `MEMORY.md` indexes and
  direct child `.md` entries only (no create/rename and no Claude memory paths),
  displays valid entry metadata or frontmatter errors, shows sanitized Markdown
  preview, warns when the complete index is over 200 lines, preserves drafts on
  exact-revision conflicts, and deletes entries only after synchronously cleaning
  matching safe index links.
- **Settings** — persistent defaults (provider-grouped model dropdown,
  thinking, queue modes, image handling, skill commands, transport,
  hide-thinking, compaction/retry, opt-in continuation after every successful automatic compaction, and maximum concurrent subagents), automatic tab-title enable/model controls, a scoped-models editor, per-agent model
  fallback editor, and the global-only nested-context policy: an auditable trusted-roots list with
  revoke and simple add-by-path controls, plus a prominent expert trust-all
  warning. The Files view remains the primary trust-grant flow. The auto-compaction continuation toggle is off by default, may keep unattended model turns and costs running indefinitely, and never affects manual `/compact`. Most defaults
  seed new sessions; opening Settings flushes pending writes and reloads durable
  global + project settings so external edits appear, while read/parse/write
  failures are shown instead of stale values. Maximum concurrent subagents defaults to 4; `0` starts new parents without the subagent tool and adds explicit self-execution guidance. Trust changes are observed by
  active processes for future lazy loads and cannot retract already injected
  context. Also includes dashboard-local preferences (thinking expansion,
  transcript image display mode, and notification permission), an appearance section with a curated-theme gallery
  (entropist.ca / Dim / Solarized / Gruvbox / Caves of Qud / Van Gogh /
  Okabe-Ito / Paul Tol — the last two colorblind-safe — live preview cards,
  system/light/dark mode selector, and Theme default / IBM Plex Mono /
  JetBrains Mono / Fira Code / Iosevka / OpenDyslexic / Atkinson Hyperlegible
  font selector, saved per browser), current pairing code,
  the 1–3650 day lifetime used by future pairings (180 days by default), and
  paired-device expiry/unpair management.
- **Pairing** — remote first-login rotating-code flow.

### Notifications and navigation

Notices, warnings, and errors for the viewed main session or subagent share a
manually dismissible banner region at the top of the transcript. Long mobile
messages scroll within a capped text area while banner actions and dismissal
remain reachable. App-global notices and notifications from other sessions use
a separate fixed top-center stack; neither surface expires automatically.

Creating a runtime from Fleet or Files leaves the current screen in place.
Closing the runtime currently being viewed likewise keeps the main-session or
subagent route and its rendered history as a read-only browser snapshot, with
explicit **Resume session** and **Return to fleet** actions. Closing another
runtime produces no redundant toast.

### Scoped models

The Settings scoped-models editor manages the persistent model-cycling scope. Search is grouped by provider, with individual model, provider, and all-model toggles; non-empty partial scopes have accessible up/down ordering controls plus save/reset, and controls remain usable on mobile. An absent `enabledModels` means implicit all available registry models in registry order, including future additions, so that view cannot be reordered. A saved partial scope is an ordered list of exact canonical `provider/model` references; editing legacy glob, fuzzy, or thinking-suffix values normalizes them to exact references.

The selected project context reads effective global + project settings, but saves always write the global setting and warn if `.dreb/settings.json` shadows it. Changes seed new sessions only and never modify a running session. Running `/scoped-models` in a dashboard session opens this editor with that session's cwd selected. For persisted-setting and RPC details, see [Model Cycling](../coding-agent/docs/settings.md#model-cycling) and [`get_settings` / `set_settings`](../coding-agent/docs/rpc.md#settings).

### Memories

The Memories screen exposes only dreb memory scopes: global `~/.dreb/memory` and populated project `.dreb/memory` directories derived from currently active sessions plus on-disk session cwd inventory. Empty or missing project memory directories are omitted because this screen cannot create entries; the global scope remains visible. Documents are existing-only: `MEMORY.md` is the special index, and entries are direct child `.md` files (excluding hidden/internal/path-like names). Local direct-child links in the rendered index open that entry in the current scope, while external links keep their normal safe behavior. Scope and document changes replace stale editor content with visible loading feedback.

Saves require the exact opaque SHA-256 revision of the UTF-8 content that was loaded. A stale revision returns a conflict and leaves the browser draft intact. Entry saves validate `name`, `description`, and `type` frontmatter (`user-preferences`, `good-practices`, `project`, or `navigation`); listing/reading malformed entries surfaces a metadata error instead of hiding them so they can be repaired. The index accepts Markdown, is shown complete, and warns when it exceeds the 200-line memory-index convention.

Deleting an entry requires both the entry revision and the current index revision (or `null` when no index exists). The server removes only index lines containing a Markdown link whose local target is exactly the entry filename or `./filename`; unsafe mixed-content lines fail loudly instead of being rewritten broadly. The cleaned index is written atomically before the entry is unlinked, and the original index is restored if unlinking fails, so a successful delete never leaves a matching dangling index link.

### Transcript images

Image blocks returned by any tool and images uploaded with a user turn render
for the human viewing the transcript, even when the active model does not
support vision. Before browser-facing SSE,
replay, hydrate, resync, parent-message, or subagent-message serialization, the
server validates exact base64, an exact PNG/JPEG/GIF/WebP MIME allowlist, and a
matching raster signature. It stores accepted originals under a content ID and
sends only `{id, mimeType, size}` references; SVG, malformed data, and MIME
mismatches are dropped. Image bytes therefore never consume SSE frame/replay
budgets or cause an `oversized_event` barrier.

The browser-local `dreb.dashboard.imageDisplayMode` preference is separate from
model-input auto-resize/block settings. **Bounded previews** are the default:
they are generated lazily in a worker, fit within 1024 × 1024 and 256 KiB, and
a click enlarges the same preview without fetching the original. **Placeholders**
make no request until the user chooses one. **Automatic originals** are an
informed Settings opt-in. Every non-original view labels the original size;
explicit downloads above 1 MiB confirm before assigning an original URL. GIF
previews are static PNG/JPEG frames, while the original route returns the exact
animated GIF.

Preview/original routes are authenticated and same-origin, return exact
allowlisted content types, `Content-Length`, `X-Content-Type-Options: nosniff`,
and private immutable caching. A 64 MiB / 2,000-record LRU deduplicates repeated
copies. On cache miss or server restart, a route re-reads only that parent or
subagent's authoritative transcript and fails explicitly if a transient image
is no longer present. Stopping a runtime revokes its image scopes. Authoritative
session history remains unchanged, so HTML exports still embed sanitized,
full-resolution originals and remain self-contained.

### Provider failures and retries

A failed assistant attempt renders an explicit `Error: <message>` line inline,
after any nonblank partial thinking or text. Empty finalized thinking placeholders
are omitted. The same per-attempt failure metadata is restored from session
history after hydration or resync; missing provider text is shown as `Unknown
error`, and aborted messages remain distinct from failures.

The latest idle assistant failure also marks the session and fleet card as a
terminal error with its reason. If automatic retry starts, terminal session and
fleet state clear in favor of the retry warning while the failed attempt remains
visible in transcript history. Hydration and resync carry retry activity, so a
refresh during backoff restores that non-terminal warning and persisted attempt.
A later success stays clear; disabled, non-retryable, and exhausted failures
remain terminal without duplicate status entries.

## Fleet transport and freshness

A normal dashboard load makes one authoritative `GET /api/fleet`; exceptional
recovery includes the fleet in its ordered `/api/resync` snapshot. After that,
live runtime cards are updated by global, event-derived `fleet_snapshot` SSE
frames, debounced by 200 ms. Those frames are built from the pool's in-memory
runtime state, so they do not trigger child RPC calls or a disk inventory scan.

Disk inventory is separate from live-runtime state. Before fleet, inventory, or
resync serialization, the server projects each on-disk session to the declared
browser DTO and bounds its first-message preview to 256 Unicode characters;
internal parent paths and complete searchable transcript text never cross this
boundary. The client narrowly refreshes inventory with `GET /api/sessions` after
create, resume, stop, or delete, rather than reloading the whole fleet. While the
Fleet screen is visible, it refreshes
per-runtime stats no more often than every 30 seconds; the refresh is
single-flight, preserves each card's last good values, and exposes refresh
failures in the UI.

Cards use the latest assistant text in hydrated client transcript entries for
their activity preview. The authoritative initial-load or resync fleet value is
the fallback until transcript entries are available. Likewise, `ctx%` is always
copied from authoritative session state or stats, never calculated in the
browser. Immediately after compaction, the session supplies a conservative
estimate over the rebuilt context until a later provider response supplies fresh
usage. Card position remains deterministic: project path, then session start
time.

Opening a session uses one `GET /api/runtimes/:key/hydrate` request. It is backed
by one `getDashboardSnapshot` RPC call and its matching ordering barrier, instead
of separately fetching state, messages, and background agents. While that view
remains mounted, periodic, turn-end, and compaction-end detail refreshes merge
back into the shared runtime state. Confirmed model/thinking mutations update the
pool snapshot and are protected from older in-flight SSE frames only until the
matching sequenced snapshot arrives. The existing replay/resync ordering contract
still applies.

## Live connection and recovery

The accessible text indicator in the top bar and persistent session header reports
the SSE connection as **connecting**, **connected**, **retrying**, **resyncing**,
**disconnected**, or **auth failed** (with retry delay where applicable); color
is not its only cue. The session-header indicator remains visible when session
details or composer controls are collapsed.
The server replays reducer-relevant projected envelopes from history bounded by
both count and bytes, with a separate byte cap for each replay. A server restart,
sequence gap, history eviction, or over-budget replay sends only that reconnect
a resync barrier at the current cursor, not a partial replay; an individually
oversized **non-image** event sends a global barrier because every browser missed it;
tool-image bytes have already been replaced by references before frame sizing.

Recovery fetches an authoritative snapshot whose HTTP `barrierSeq` was captured
synchronously at the RPC snapshot marker, discards queued envelopes through that
sequence, then replays only later envelopes. A viewed subagent has an additional
disk-read boundary so intervening relays are not lost. This restores transcripts,
background-agent state, and the atomically replaced task list after a hard refresh
or gap without interrupting healthy browsers. Backpressure disconnects a slow
client and uses the same recovery path; a foreground 60-second liveness watchdog
does likewise for a stalled stream. Named, unnumbered heartbeats arrive every 25
seconds.

Retries use client-owned capped exponential backoff (maximum 30 seconds) with
±25% jitter. The attempt count resets only after 60 seconds of healthy
liveness, not on socket open. Returning to a visible tab always validates auth;
validation is aborted after 10 seconds so a black-holed request cannot stall
recovery. A 401/403 becomes **auth failed**, while timeouts and other failures
recover normally.
Optional correlated diagnostics are dashboard-authenticated, metadata-only,
4 KiB-capped, and rate-limited (one summary per connection every 30 seconds);
they never include prompts, cookies, SSE payloads, or tool data.

See the full [dashboard recovery contract](../coding-agent/docs/dashboard.md#live-connection-and-recovery) and [RPC snapshot ordering](../coding-agent/docs/rpc.md#get_dashboard_snapshot).

## Nested context trust

The Files trust controls apply only to **lazy nested/out-of-cwd** context
loading. They do not control dreb's separate initial upward scan for
`AGENTS.md`/`CLAUDE.md` from a session's launch cwd.

Lazy loading is off by default. The Files view is the primary grant flow:
trust the viewed folder and descendants, or untrust its actual granting root.
Settings also lists every configured root for audit and revoke, and offers a
simple add-by-path control. Trusting through either screen writes an explicit,
global-only `context.trustedFolders` root in
`~/.dreb/agent/settings.json`; that root covers itself and descendants after
canonical native-`realpath` resolution. A symlink that lexically appears below
a root but resolves outside it is not trusted. Project `.dreb/settings.json`
cannot enable, disable, or extend nested-context trust; only global settings
and the dashboard Files/Settings controls can, so a cloned repository cannot
grant itself trust.

The Files view reports the actual state returned by RPC: `untrusted`,
`trusted-root` (including an inherited canonical granting root), or
`unrestricted`. Its **untrust** action removes the granting root, not merely
the selected descendant. `context.autoLoadNested: true` is a global-only expert
trust-all override; it allows any resolvable directory and can inject
prompt-injection content from untrusted repositories, so folder controls cannot
narrow it. Main agents and subagents share this policy. Active processes see
trust changes before future lazy loads, but already injected context cannot be
removed. Permitted lazy context is secret-scrubbed, appended after extension
`tool_result` transforms, and deduplicated per session.

## Security model — exactly two modes

**Local (default).** The server binds the loopback interface only. LAN packets
never reach the process. No login. Host/Origin headers are validated on every
request (DNS-rebinding defense).

**Remote (opt-in).** Requires [Tailscale](https://tailscale.com):

```bash
dreb-dashboard --remote --allow you@example.com
```

Enforcement layers, all fail-closed:

1. Peer-specific Tailscale identity resolution (`tailscale whois`); concurrent
   requests for the same normalized peer share one in-flight lookup, while
   resolver failures remain fail-closed and distinct from a clean unknown peer
2. Identity allowlist — empty allowlist denies everyone
3. First-login pairing code: 6 digits, rotates every 30 seconds, shown live in
   the dashboard Settings tab on the host machine (also printed at startup as a
   headless fallback)
4. Signed per-device cookie thereafter. New pairings last 180 days by default;
   Settings accepts 1–3650 days for future pairings without rewriting existing
   expiries. Devices in the final 10% of their recorded lifetime receive an
   advance warning at most once per UTC day. Devices and expiry dates are listed
   in settings and can be unpaired.

**There is no LAN mode.** Access from another device — even on the same LAN —
goes through Tailscale.

A paired device has the same power as sitting at the terminal: it can chat
with agents, run commands through them, browse the host's files, and
upload/download. Every file operation is logged server-side. Browser
notifications are opt-in per device from settings; the tab-title attention
badge works without permission.

## WSL2 gotcha — intermittent "access denied" / pairing screen on localhost

Running the dashboard inside **WSL2** and reaching it from a Windows browser can
intermittently show an access-denied / pairing screen on `http://127.0.0.1`
right after the WSL VM has been idle. It's a WSL mirrored-networking quirk (the
loopback source address is transiently `10.255.255.254`, which fails local-mode
auth's `127.x`/`::1` check), not a dreb bug. Keeping a WSL terminal open — or a
headless keep-alive — avoids it. Full explanation and workarounds:
[WSL2 gotcha](../coding-agent/docs/dashboard.md#wsl2-gotcha).

## Options

| Flag | Description |
|---|---|
| `--port <n>` | Port (default 5343) |
| `--remote` | Enable remote mode (requires Tailscale) |
| `--allow <identity>` | Tailscale login name allowed to pair (repeatable, required with `--remote`) |
| `--https` | Terminate TLS on the dashboard itself (native TLS, no reverse proxy, no auth-model change). Requires `--cert` and `--key`. Mainly for `--remote` (loopback is already a secure context); use `tailscale cert` files for a tailnet hostname so mobile PWAs + notifications work. Note: with `--https` the server speaks TLS only, so the host's plain-HTTP local tab (`http://127.0.0.1`) stops working — use the tailnet hostname (`https://…`) there. |
| `--cert <path>` | PEM certificate file (required with `--https`; hot-reloaded on file change) |
| `--key <path>` | PEM private key file (required with `--https`; hot-reloaded on file change) |

## PWA + mobile notifications

The dashboard is an **installable PWA** — web app manifest, service worker, and
icon set. Install to the home screen on Android Chrome and iOS Safari 16.4+ for
a standalone, no-URL-bar app.

Needs-attention notifications go through the **service worker**
(`registration.showNotification`) — the only path that works on Android Chrome
(which removed the page `Notification` constructor) and on iOS (installed PWA
only, 16.4+). The tab-title `◆` badge is the in-tab fallback. Notifications
require a **secure context** — `localhost`/`127.0.0.1` already qualifies, so
local-mode works with no setup. For remote access over the tailnet, enable
native TLS (`--https --cert --key`) with `tailscale cert` files; the auth model
is unchanged (the peer address stays the real tailnet IP). See
`packages/coding-agent/docs/dashboard.md` for the full setup walkthrough.

## Architecture

```
Browser (SolidJS, hash-routed SPA)
  ⇄ REST + SSE (Express server, fail-closed auth middleware)
  ⇄ RpcClient pool — one `dreb --mode rpc` child per live session
```

- Events stream over one SSE connection carrying `{seq, key, event}` envelopes.
  Count/byte-bounded projected replay and an explicitly captured snapshot cursor
  provide recovery; see [Live connection and recovery](#live-connection-and-recovery).
  Deleting a runtime publishes a synthetic `runtime_removed` event so clients
  evict that session's state.
- Background subagent transcripts arrive over the same pipe via the
  `background_agent_event` relay (see `docs/rpc.md` in
  `@dreb/coding-agent`) — no session-file tailing.
- Programmatic callers of `createDashboardServer()` must call the returned
  app's idempotent `closeDashboard()` hook when their HTTP server stops. This
  terminates the lazy image-preview worker without requiring access to the
  internally created image service.
- The visual language is `tokens.css` (`src/client/styles/tokens.css`),
  the dashboard's design system. Its defaults are unchanged; `themes.css` is
  an **additive layer** on top that overrides the design tokens only when a
  curated theme or a forced color mode is active.
- **Appearance system** (`src/client/state/appearance.ts` + `styles/themes.css`
  + `components/theme-gallery.tsx`) — a dashboard-native theming surface,
  independent of the TUI themes. Eight curated themes (entropist.ca, Dim,
  Solarized, Gruvbox, Caves of Qud, Van Gogh, and the colorblind-safe Okabe-Ito
  and Paul Tol palettes), each with light and dark palettes, plus a
  system/light/dark mode.
  A settings theme gallery renders live preview cards beside mode and font
  selectors; selections persist per browser in `localStorage` (a pristine
  entropist.ca + system + Theme default install leaves no keys and matches the
  `tokens.css` baseline exactly). Theme default keeps each theme's built-in
  family: most use Google-hosted IBM Plex Mono, while Gruvbox uses the bundled
  self-hosted JetBrains Mono (OFL, in `src/client/assets/fonts/`). An explicit
  IBM Plex Mono, JetBrains Mono, Fira Code, Iosevka, OpenDyslexic, or Atkinson
  Hyperlegible selection overrides any theme and is reflected in previews. The
  self-hosted families — JetBrains Mono, Fira Code, Iosevka, the bundled
  dyslexia-friendly OpenDyslexic, and the low-vision-friendly Atkinson
  Hyperlegible (all OFL, same directory) — are
  lazy-loaded only when active typography uses them. No `light-dark()` (iOS
  Safari 16.4 floor); a synchronous `index.html` bootstrap
  prevents a wrong-appearance flash. The static
  `manifest.webmanifest` keeps white (default-light) launch colors as the
  fallback, while the live `theme-color` meta follows the active appearance.

## Development

```bash
npm run build   # server (tsgo) + client (vite) → dist/
npm test        # server, reducer, and screen smoke tests
```

### Mobile transport profiling

Run the opt-in local profiler on the dashboard host:

```bash
npm run --workspace @dreb/dashboard profile:mobile -- http://127.0.0.1:5343
```

It emits aggregate, payload-free HTTP/SSE timing, size, event-type, and burst
metrics; it does not save fleet or event contents. Capture the default 60
seconds against a realistic workload of at least five live runtimes. For browser
acceptance, use Chromium network throttling at 100 ms RTT and 1.5 Mbps; HTTP
packet loss is not emulated.

See `packages/coding-agent/docs/dashboard.md` in the repo for the full
product documentation, including systemd and launchd auto-restart setup.
