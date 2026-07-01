# Dashboard

`@dreb/dashboard` is dreb's first-party browser dashboard. It provides a local web UI for browsing projects and files, opening sessions, chatting with dreb agents, watching live events/subagents, and adjusting runtime settings.

The dashboard is a separate workspace package and talks to `@dreb/coding-agent` through the native RPC client. Each active project/session gets its own runtime entry so the dashboard does not silently switch a running agent across unrelated project contexts.

## Install and launch

From a source checkout:

```bash
npm install
npm run build
npm link -w packages/dashboard
dreb-dashboard
```

By default the server binds to `127.0.0.1:3762`:

```bash
dreb-dashboard --host 127.0.0.1 --port 3762
```

Open the printed local URL in a browser on the host machine.

## Localhost mode

Same-machine loopback access is allowed without pairing friction. This is the default and safest mode:

```bash
dreb-dashboard
```

Do not bind to `0.0.0.0` unless remote mode is intentionally enabled and configured.

## Tailscale remote mode

Remote access is opt-in. Use Tailscale identities/devices and PIN pairing:

```bash
dreb-dashboard \
  --host 0.0.0.0 \
  --remote true \
  --allowed-identity drew@example.com \
  --allowed-device drews-phone
```

When remote mode starts, the server prints a short-lived pairing PIN. Open the dashboard from the allowed Tailnet device and enter the PIN. The paired browser receives an HTTP-only pairing cookie and future API calls are authorized until the pairing expires.

Remote requests fail closed when:

- remote mode is disabled
- the request is not from a verified Tailscale peer
- no Tailscale identity or device allowlist is configured
- the peer does not match the allowlist
- the browser has not completed PIN pairing

The production resolver uses `tailscale status --json` and matches the socket remote address against Tailnet peer addresses. The dashboard does not trust caller-supplied identity headers.

## Features

- Browse configured roots (`cwd` and home by default)
- Browse directories with path traversal and symlink escape checks
- Upload files into the selected folder with size limits
- Download files from allowed roots with size limits
- List all sessions and sessions for the selected project
- Open a new runtime or resume a project session
- Send prompts, steering messages, follow-ups, and aborts
- Load current runtime state and historical messages
- Stream live agent events with SSE
- Show tasks, suggest-next commands, event log entries, and background subagent lifecycle events
- Change model, thinking level, steering mode, and follow-up mode through RPC-backed settings controls

## Security notes

The dashboard can control agents and move files on the host. Treat it as a powerful local control plane:

- Keep the default localhost binding unless remote access is needed.
- Use Tailscale for non-localhost access, including devices on the same LAN.
- Configure specific allowed identities/devices; empty allowlists deny remote clients.
- Pair each remote browser/device with the short-lived PIN shown on the host.
- Avoid exposing the dashboard to a public network or unauthenticated reverse proxy.
- File APIs are intentionally separate from model tools; human upload/download is authorized at the dashboard boundary.

## MVP limitations

- The embedded terminal pane is not part of the MVP.
- Full custom TUI component rendering is not reused directly; the dashboard renders the core RPC event categories and supported extension UI events.
- Remote TLS/origin hardening depends on the deployment path. Prefer Tailscale-local access rather than public exposure.
