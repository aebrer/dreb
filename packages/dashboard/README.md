# @dreb/dashboard

First-party web dashboard for dreb. It serves a minimalist responsive browser UI for project/file browsing, session history, chat controls, live events/subagents, and runtime settings.

## Launch

```bash
npm run build
npm link -w packages/dashboard
dreb-dashboard
```

Default: `http://127.0.0.1:3762`.

Options:

```bash
dreb-dashboard [--host 127.0.0.1] [--port 3762] [--cwd /project] [--agentDir ~/.dreb/agent]
```

Remote access is opt-in and should go through Tailscale:

```bash
dreb-dashboard \
  --host 0.0.0.0 \
  --remote true \
  --allowed-identity drew@example.com \
  --allowed-device drews-phone
```

The server prints a short-lived PIN for remote browser pairing. Localhost access does not require pairing.

## Security model

- Local loopback clients are allowed by default.
- Non-loopback clients are rejected unless remote mode is enabled.
- Remote mode requires verified Tailscale peer identity/device allowlisting.
- Empty remote allowlists deny access.
- Remote browsers must complete PIN pairing before API control is granted.
- Pairings are stored in `dashboard-pairings.json` under the dreb agent directory.

See [`packages/coding-agent/docs/dashboard.md`](../coding-agent/docs/dashboard.md) for full usage and security notes.
