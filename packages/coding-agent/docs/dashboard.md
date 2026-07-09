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

The settings tab exposes a browser-local permission toggle for needs-attention
notifications. When permission is granted, a hidden dashboard tab sends a
browser notification when a session newly needs input; all browsers still get a
`◆` tab-title badge fallback.

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

Single breakpoint at 700px. On mobile: fleet cards stack, the session view
prioritizes read-and-steer (model/thinking switchers collapse into ⋯, tasks
default collapsed), file table shows name + download only. Composer modes,
abort, and needs-attention affordances are never reduced away — steering a
running agent from a phone is the primary remote use case.

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
- **Design source**: `design/dashboard/` (SPEC.md, PARITY.md, tokens.css,
  mockups). tokens.css is adopted unmodified; a unit test enforces
  byte-equality.

## Limitations (deliberate, sequenced later)

- No session tree screen yet (fork-from-message covers the go-back-and-re-edit
  loop; the tree design and RPC are ready).
- No shell passthrough from the browser.
- No subagent steering (the drill-in view is read-only).
- Fixed light/dark via `prefers-color-scheme` — no TUI-theme following.

See `design/dashboard/PARITY.md` for the full TUI-parity disposition table.
