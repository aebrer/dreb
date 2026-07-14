# Web Dashboard

`dreb dashboard` launches a browser UI for dreb: a fleet overview of sessions
across projects, a full-parity chat view, live background-subagent
observability, host file browsing, and settings — usable from desktop and
mobile browsers.

The dashboard lives in the `@dreb/dashboard` package. Live agent control goes
over [RPC mode](rpc.md): the server maintains a pool of `dreb --mode rpc`
child processes, one per live session. The server uses dreb's public session
APIs for on-disk inventory/delete and serves its own host file API.

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

1. **Tailscale reachability** — the peer address must resolve to a tailnet
   identity via `tailscale status --json`. No Tailscale, no access.
2. **Identity allowlist** — `--allow` login names. An empty allowlist denies
   everyone. Rejected identities see a denial page naming the identity.
3. **Pairing code** — first login from a new device requires the current
   6-digit rotating code. The code is shown live in settings → devices on the
   host/local dashboard and rotates every 30 seconds (the current code is also
   printed at server start as a headless fallback). It proves the person can
   see the host machine's local dashboard, so a stolen allowlist identity can't
   quietly gain access.
4. **Device cookie** — successful pairing sets a signed HttpOnly cookie
   (30-day expiry). Paired devices are listed in settings → devices and can be
   unpaired at any time.

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
| **Fleet** | Home. Live-first: one grid of every live session at the top — status chip (● running / ◆ needs-attention / ○ idle / ✕ error), project path, activity line, live subagent lines, tasks progress, ctx%, model, last activity. Live cards keep a deterministic order by project path, then session start time; needs-attention cards badge the browser tab without jumping around. Below the grid: past sessions grouped by project, three compact rows per group with an "all N on disk" expander, resume and delete. |
| **Session view** | Full chat drill-in. Markdown streaming transcript (text, thinking blocks with expand preference, agent-result cards, tool cards with bespoke read/write/edit/bash bodies plus full expandable inputs and markdown-rendered results for markdown-contract tools like subagent/skill/web_fetch/suggest_next, compaction/branch summaries, custom messages), per-message copy, tasks panel, subagent strip, status line with elapsed time plus ■ stop and compaction/retry aborts, and an info bar with cwd, branch, session name, token breakdown, cost/(sub)/daily rollup, ctx%, median tok/s, and a stats popover. Composer supports auto-grow, history, `/` autocomplete from `get_commands`, image attach/paste, queued-message chips with restore-all, steer/follow-up modes, and suggest-next. The ⋯ menu covers export HTML, compact, rename, fork-from-message, loaded context, and tool expand/collapse. Session names update live from manual rename or auto-naming. Extension UI requests (select/confirm/input/editor) render as modals; notifications as toasts. |
| **Subagent view** | Read-only transcript of a background agent: live events via the RPC relay, hydrated from the agent's on-disk session log (`/subagents/:agentId/messages`) so the view survives browser reloads. Shows the task, streaming output, and tool activity. No composer — subagents can't be steered yet; the parent session controls them. |
| **Files** | Host-wide browser with places shortcuts (home, /tmp, project roots), breadcrumbs to `/`, new-folder, download, drop-zone/picker upload with explicit collision prompts, and "new session here" on any directory. |
| **Settings** | Persistent defaults (default model, thinking level, steering/follow-up queue modes, auto-compaction, auto-retry) via `get_settings`/`set_settings` — validation errors are shown verbatim. Dashboard-local preferences (always expand thinking, needs-attention notification permission) live in the browser. Shows the current rotating pairing code on the host/local dashboard, plus the paired-devices list with unpair. |
| **Pairing** | Remote first-login: identity echo, rotating-code entry, and the security copy explaining what pairing grants. |

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
- The session view shows a chip strip — one chip per background agent; click
  to drill into its live transcript.
- The drill-in view streams the child's events in real time via the
  `background_agent_event` relay (see [RPC events](rpc.md#event-types)) and
  hydrates from the agent's on-disk session log on mount, so transcripts
  survive browser reloads and remain viewable after the agent finishes.

## Responsive behavior

Single breakpoint at 700px. At <=700px, fleet cards stack; long session names,
status chips, project paths, activity and subagent text, and past-session
labels wrap within their cards or rows rather than spilling off-screen. The
session view prioritizes read-and-steer (model/thinking switchers collapse into
⋯, tasks default collapsed), and the file table shows name + download only.
Composer modes, abort, and needs-attention affordances are never reduced away
— steering a running agent from a phone is the primary remote use case.

## Architecture

```
Browser dashboard (SolidJS + Vite, tokens.css design system)
  ⇄ Express server: fail-closed auth, REST, SSE fanout, file API
  ⇄ RpcClient pool — one `dreb --mode rpc --ui dashboard` child per session
  ⇄ sessions on disk (~/.dreb/agent/sessions), settings, models
```

- **SSE catch-up**: events carry sequence IDs; reconnects replay from
  `Last-Event-ID` against a bounded buffer, falling back to a full state
  refetch when the gap is too old. Slow clients whose server-side write
  buffer exceeds a bound are disconnected (loudly logged) and recover via
  the same reconnect path. Deleting a runtime publishes `runtime_removed`
  so browsers evict that session's transcript state.
- **ctx%** comes from the session itself (`get_state.contextUsage` — the same
  numbers the TUI footer shows), never client-side estimates.
- **Auto-naming** runs in the shared `AgentSession` layer, so dashboard-created
  RPC sessions get the same LLM-generated session names as the TUI and update
  live via `session_name_changed`.
- **Visual language**: `tokens.css` (`packages/dashboard/src/client/styles/`),
  the dashboard's design system — IBM Plex Mono, light + dark via
  `prefers-color-scheme`.

## Limitations (deliberate, sequenced later)

- No session tree screen yet (fork-from-message covers the go-back-and-re-edit
  loop; the tree design and RPC are ready).
- No shell passthrough from the browser.
- No subagent steering (the drill-in view is read-only).
- Fixed light/dark via `prefers-color-scheme` — no TUI-theme following.
