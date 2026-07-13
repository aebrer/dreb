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
  `+ new session` anywhere.
- **Session view** — full chat parity: markdown streaming transcript, tool
  cards, thinking blocks, compaction summaries, per-message copy, tasks panel,
  suggest-next chip, slash-command autocomplete, image attach/paste,
  queued-message restore, footer-parity info bar (branch, tokens, cost, ctx%,
  median tok/s), stats/loaded-context/fork modals, steer/follow-up composer
  modes, ■ abort, model/thinking switchers, extension-UI modals, export HTML,
  and live auto-naming.
- **Subagent drill-in** — read-only transcript of a background agent: live
  events via the relay, hydrated from the agent's on-disk session log so the
  view survives browser reloads. No composer: the parent session controls the
  agent.
- **Files** — host-wide browse with places shortcuts, upload (collision
  prompts before overwrite), download, new-folder, "new session here".
- **Settings** — persistent defaults (provider-grouped model dropdown,
  thinking, queue modes, image handling, skill commands, nested context,
  transport, hide-thinking, compaction/retry), per-agent model fallback editor,
  dashboard-local preferences (thinking expansion and notification permission),
  current pairing code, and paired-devices management.
- **Pairing** — remote first-login rotating-code flow.

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

- Events stream over a single SSE connection carrying `{seq, key, event}`
  envelopes; reconnects catch up via `Last-Event-ID` against a bounded ring
  buffer (a gap triggers a `dashboard_resync` + full refetch). Deleting a
  runtime publishes a synthetic `runtime_removed` event so clients evict that
  session's state. Clients that stop draining the stream past a bounded
  write buffer are disconnected and rely on reconnect catch-up.
- Background subagent transcripts arrive over the same pipe via the
  `background_agent_event` relay (see `docs/rpc.md` in
  `@dreb/coding-agent`) — no session-file tailing.
- The visual language is `tokens.css` (`src/client/styles/tokens.css`),
  the dashboard's design system, adopted unmodified from the accepted
  design phase.

## Development

```bash
npm run build   # server (tsgo) + client (vite) → dist/
npm test        # server, reducer, and screen smoke tests
```

See `packages/coding-agent/docs/dashboard.md` in the repo for the full
product documentation.
