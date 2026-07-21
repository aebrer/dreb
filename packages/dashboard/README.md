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
  ctx%, model, cost, last-assistant preview). Below, past sessions grouped by project — three
  compact rows each with an "all N on disk" expander — with resume/delete.
  At <=700px, cards stack; long session names, status chips, project paths,
  activity/subagent text, and past-session labels wrap within cards or rows
  rather than spilling off-screen. `+ new session` anywhere.
- **Session view** — full chat parity: markdown streaming transcript, tool
  cards, thinking blocks, compaction summaries, per-message copy, tasks panel,
  suggest-next chip, slash-command autocomplete, image attach/paste,
  queued-message restore, persistent session-header live indicator, footer-parity info bar (branch, tokens, cost, ctx%,
  median tok/s), stats/loaded-context/fork modals, steer/follow-up composer
  modes, ■ abort, model/thinking switchers, extension-UI modals, export HTML,
  and live auto-naming.
- **Subagent drill-in** — read-only transcript of a background agent: live
  events via the relay, hydrated from the agent's on-disk session log so the
  view survives browser reloads. No composer: the parent session controls the
  agent.
- **Files** — host-wide browse with places shortcuts, upload (collision
  prompts before overwrite), download, new-folder, "new session here", and the
  effective global nested-context trust for the viewed canonical folder. Trust
  the folder and descendants, or untrust the actual granting root (including
  its inherited descendants).
- **Settings** — persistent defaults (provider-grouped model dropdown,
  thinking, queue modes, image handling, skill commands, transport,
  hide-thinking, compaction/retry), per-agent model fallback editor, and the
  global-only nested-context policy: an auditable trusted-roots list with
  revoke and simple add-by-path controls, plus a prominent expert trust-all
  warning. The Files view remains the primary trust-grant flow. Most defaults
  seed new sessions; opening Settings flushes pending writes and reloads durable
  global + project settings so external edits appear, while read/parse/write
  failures are shown instead of stale values. Trust changes are observed by
  active processes for future lazy loads and cannot retract already injected
  context. Also includes dashboard-local preferences (thinking expansion and
  notification permission), an appearance section with a curated-theme gallery
  (entropist.ca / Dim / Solarized / Gruvbox / Caves of Qud / Van Gogh /
  Okabe-Ito / Paul Tol — the last two colorblind-safe — live preview cards,
  system/light/dark mode selector, saved per browser), current pairing code,
  and paired-devices management.
- **Pairing** — remote first-login rotating-code flow.

## Fleet transport and freshness

A normal dashboard load makes one authoritative `GET /api/fleet`; exceptional
recovery includes the fleet in its ordered `/api/resync` snapshot. After that,
live runtime cards are updated by global, event-derived `fleet_snapshot` SSE
frames, debounced by 200 ms. Those frames are built from the pool's in-memory
runtime state, so they do not trigger child RPC calls or a disk inventory scan.

Disk inventory is separate from live-runtime state. The client narrowly refreshes
it with `GET /api/sessions` after create, resume, stop, or delete, rather than
reloading the whole fleet. While the Fleet screen is visible, it refreshes
per-runtime stats no more often than every 30 seconds; the refresh is
single-flight, preserves each card's last good values, and exposes refresh
failures in the UI.

Cards use the latest assistant text in hydrated client transcript entries for
their activity preview. The authoritative initial-load or resync fleet value is
the fallback until transcript entries are available. Likewise, `ctx%` is always
copied from authoritative session state or stats, never calculated in the
browser. Card position remains deterministic: project path, then session start
time.

Opening a session uses one `GET /api/runtimes/:key/hydrate` request. It is backed
by one `getDashboardSnapshot` RPC call and its matching ordering barrier, instead
of separately fetching state, messages, and background agents. The existing
replay/resync ordering contract still applies.

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
oversized event sends a global barrier because every browser missed it.

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

1. Tailscale identity resolution of the peer address (`tailscale status`)
2. Identity allowlist — empty allowlist denies everyone
3. First-login pairing code: 6 digits, rotates every 30 seconds, shown live in
   the dashboard Settings tab on the host machine (also printed at startup as a
   headless fallback)
4. Signed per-device cookie thereafter; devices are listed and unpair-able in
   settings

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
  A settings theme gallery renders live preview cards; selections persist per
  browser in `localStorage` (a pristine entropist.ca + system install leaves no
  keys and matches the `tokens.css` baseline exactly). Most themes use IBM Plex Mono;
  Gruvbox uses self-hosted JetBrains Mono (OFL, in `src/client/assets/fonts/`),
  lazy-loaded only when active. No `light-dark()` (iOS Safari 16.4 floor); a
  synchronous `index.html` bootstrap prevents a wrong-theme flash. The static
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
product documentation.
