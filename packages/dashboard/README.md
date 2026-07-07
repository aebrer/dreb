# @dreb/dashboard

Web dashboard for [dreb](https://github.com/aebrer/dreb) — a visual, real-time,
mobile-friendly interface for browsing projects and sessions, controlling
multiple dreb agents, watching background subagents live, and using dreb from
devices that are not sitting at the host terminal.

The dashboard is a pure RPC client: it spawns `dreb --mode rpc` child
processes (one per live session) and never imports dreb session internals.

## Install & launch

```bash
npm install -g @dreb/dashboard

# local-only (default): binds 127.0.0.1, no auth needed
dreb-dashboard

# or via the dreb CLI
dreb dashboard
```

Open `http://127.0.0.1:5343`.

## Screens

- **Fleet** (home) — live sessions grouped by project: status chips, current
  activity, live subagents, task progress, ctx%, model. On-disk session
  inventory with resume/delete. `+ new session` anywhere.
- **Session view** — full chat parity: streaming transcript, tool cards,
  thinking blocks, compaction summaries, tasks panel, suggest-next chip,
  steer/follow-up composer modes, ■ abort, model/thinking switchers,
  extension-UI modals, export HTML.
- **Subagent drill-in** — read-only live transcript of a background agent via
  the event relay. No composer: the parent session controls the agent.
- **Files** — host-wide browse with places shortcuts, upload (collision
  prompts before overwrite), download, new-folder, "new session here".
- **Settings** — persistent defaults (model, thinking, queue modes,
  compaction/retry) + paired-devices management.
- **Pairing** — remote first-login PIN flow.

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
3. First-login PIN pairing: 6 digits, single-use, 5-minute expiry, printed to
   the host terminal
4. Signed per-device cookie thereafter; devices are listed and unpair-able in
   settings

**There is no LAN mode.** Access from another device — even on the same LAN —
goes through Tailscale.

A paired device has the same power as sitting at the terminal: it can chat
with agents, run commands through them, browse the host's files, and
upload/download. Every file operation is logged server-side.

## Options

| Flag | Description |
|---|---|
| `--port <n>` | Port (default 5343) |
| `--remote` | Enable remote mode (requires Tailscale) |
| `--allow <identity>` | Tailscale login name allowed to pair (repeatable, required with `--remote`) |

## Architecture

```
Browser (SolidJS, hash-routed SPA)
  ⇄ REST + SSE (Express server, fail-closed auth middleware)
  ⇄ RpcClient pool — one `dreb --mode rpc` child per live session
```

- Events stream over a single SSE connection carrying `{seq, key, event}`
  envelopes; reconnects catch up via `Last-Event-ID` against a bounded ring
  buffer (a gap triggers a `dashboard_resync` + full refetch).
- Background subagent transcripts arrive over the same pipe via the
  `background_agent_event` relay (see `docs/rpc.md` in
  `@dreb/coding-agent`) — no session-file tailing.
- The visual language is `tokens.css` from the accepted design
  (`design/dashboard/` in the repo), adopted unmodified and enforced by a
  byte-equality test.

## Development

```bash
npm run build   # server (tsgo) + client (vite) → dist/
npm test        # server, reducer, and screen smoke tests
```

See `packages/coding-agent/docs/dashboard.md` in the repo for the full
product documentation.
