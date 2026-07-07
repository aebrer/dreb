# dreb Dashboard — Design Spec

UX/UI specification for the dreb web dashboard (implementation issue 307,
design issue 311). Companion artifacts in this directory:

- `tokens.css` — design tokens + shared primitives (the visual language, enforced in code)
- `mockups/*.html` — six static screens sharing `tokens.css`
- `screenshots/*.png` — committed captures (desktop 1440×900 light+dark, mobile 390×844)
- `PARITY.md` — TUI feature parity checklist (the coverage authority)
- `capture.mjs` — regenerates screenshots

## 1. Information architecture

**Fleet-centric** (decided on issue 311): the home screen is a cross-project,
multi-session overview; each session drills into a full-parity chat view.
Navigation is `fleet ⇄ session`, not tabs-around-one-session.

```
fleet (home) ────────────────┐
 │  sessions grouped by       │ topbar: fleet · files · settings
 │  project; live cards +     │ (files/settings are global tabs)
 │  on-disk inventory         │
 ├─→ session view ──→ tree screen (per-session)
 ├─→ files tab (per-project browse/upload/download)
 └─→ settings tab (defaults + devices)
pairing screen: shown once per new remote device, outside the tab structure
```

**The fleet boundary (explicit):** "live" sessions are runtimes the dashboard
server manages (its RPC runtime pool). Sessions on disk are browsable,
resumable inventory — resuming promotes one into a live runtime. Externally
running TUI processes are **invisible** to the dashboard: dreb has no liveness
mechanism for foreign processes, and the dashboard must not pretend otherwise.
The fleet screen renders this as two distinct strata per project: live cards,
then an "on disk" list (`mockups/fleet-overview.html`).

**Needs-attention is a first-class boolean**, not a status flavor. It drives:
sort order (attention cards first within their project), visual weight (filled
amber chip + colored card border — never color alone; every status pairs a
glyph: ● running, ◆ needs-attention, ○ idle, ✕ error), the browser tab badge,
and (permission-granted) a browser notification. Sources: extension UI
requests awaiting response, `parent_paused_for_background_agents`, error
states, and stream-abort-requiring conditions.

## 2. Screens

| Screen | Mockup | Purpose |
|---|---|---|
| Fleet overview | `fleet-overview.html` | Home: live cards per project (status chip, current activity line, live subagents, tasks progress, ctx%, model), on-disk inventory with resume/delete, new-session entry, global counters |
| Session view | `session-view.html` | Chat drill-in: full-parity transcript, dock (tasks, status line, composer), session bar (back, name, model/thinking/ctx switchers, ⋯ overflow) |
| Tree | `tree.html` | Session tree: filter chips, role+preview+label rows, "you are here" leaf marker, navigate-confirm modal with summarize option |
| Files | `files.html` | Per-project browse, breadcrumbs, download, drop-zone upload with host-consequence copy |
| Settings | `settings.html` | Persistent defaults (get/set_settings surface: model, thinking, queue modes, compaction/retry toggles) + paired-devices management |
| Pairing | `pairing.html` | Remote first-login: identity echo, 6-digit PIN, expiry, "why a PIN" + "what pairing grants" copy |

The transcript's structural reference is the export-html renderer
(`core/export-html/`): entry types, collapse behavior, and per-tool formatting
follow `renderEntry()`/`renderToolCall()`, adapted for live streaming. The
mockups demonstrate every major entry family; PARITY.md §4 enumerates full
coverage.

## 3. UX flows

**First launch (local).** `dreb dashboard` starts the server loopback-bound and
prints the URL. Opening `http://127.0.0.1:<port>` lands directly on the fleet —
no login, no pairing (loopback is trusted; see §6). Empty state: one card-sized
prompt to create a session in a recent project.

**Remote pairing.** Device on the tailnet opens the dashboard URL → server
checks Tailscale identity against the allowlist → allowed identities see the
pairing screen (`pairing.html`); others get a plain denial page naming the
identity that was rejected. User enters the PIN shown in the host terminal
(6 digits, single-use, 5-minute expiry — countdown shown). Success sets a
signed device cookie and lands on the fleet. The device appears in
settings → devices with unpair.

**Project selection / new session.** "+ new session" (global or per-project
header) → modal: project path (recent projects listed; free-text path entry),
optional first prompt. Creates a runtime via `new_session`, navigates into it.

**Resume.** On-disk row "resume" → promotes to live runtime (`switch_session`
on a pooled runtime), navigates into the session view with history hydrated
via `get_messages`.

**Chat.** §5. **Subagent monitoring.** Live subagent lines on fleet cards
(`background_agent_start/end`); session view shows the same strip above the
status line. Subagents are read-only surfaces (dreb offers no external
control channel for them beyond the parent).

**File transfer.** Files tab, breadcrumb-scoped to a project root. Downloads
stream from the server (path-guard enforced server-side). Uploads via
drop-zone or picker; collision prompts before overwrite. Warning copy is fixed
on the screen, not a dismissible toast (`files.html`).

**Settings.** Reads both `get_state` (live) and `get_settings` (defaults);
the tab edits **defaults** and says so ("Live sessions keep their current
values — change those from the session view"). Writes via `set_settings`;
validation errors surface verbatim (the RPC rejects loudly rather than
clamping — the UI must show the error, not retry silently).

**Tree operations.** Session ⋯ → "tree" (or the fleet card for a live
session). Filter chips mirror TUI filter modes. Selecting a node opens the
navigate-confirm modal: plain move vs move+summarize (LLM-bound, shows
progress; 5-minute client budget per `docs/rpc.md`). Navigating to a user
message returns `editorText` → composer prefills for re-edit, matching TUI
behavior. Copy states "nothing is deleted."

## 4. Responsive layout

Single breakpoint at **700px**. Grid/flex reflow plus deliberate per-screen
control-surface reduction — not just reflow:

| Screen | Desktop | Mobile changes |
|---|---|---|
| Fleet | Card grid (`minmax(340px, 1fr)`), disk rows single-line | Cards stack single-column; disk-row metadata wraps below name; all touch targets full-width-friendly |
| Session view | Transcript max-width 960px; dock shows tasks open; session bar shows model/think/ctx switchers | **Read-and-steer priority**: model/thinking switchers collapse into ⋯ overflow, ctx% stays; tasks panel defaults collapsed; project path hidden; user messages full-width |
| Tree | Role column 7em, timestamps right | Timestamps hidden; role column 4em; modal becomes bottom sheet |
| Files | Table with size/modified columns | Size/modified columns hidden; name + download only |
| Settings | Label left, control right | Rows stack vertically, control right-aligned |
| Pairing | Centered card | Same card, full-width |

Composer modes, abort, and needs-attention affordances are **never** reduced
away on mobile — steering a running agent from a phone is the primary remote
use case.

## 5. Interaction design

**Composer modes — concrete definitions.** The TUI's implicit submit semantics
become an explicit two-state toggle, visible only while the agent is streaming
(idle: plain send):

- **steer** — deliver now: injected into the running turn after the current
  tool call completes (RPC `steer`). Delivery timing depends on the steering
  queue mode (`all` vs `one-at-a-time`) shown in settings.
- **follow-up** — queue for after the agent finishes the current work
  (RPC `follow_up`).
- **interrupt** (the third vocabulary item) — not a send mode: the ■ stop
  button (RPC `abort`). Research precedent (Happy's three modes) maps to:
  steer = steer-now, follow-up = queue, interrupt = abort button.

Queued messages render as dismissible chips above the composer (dequeue =
TUI `alt+up`; per-chip ✕ restores text to the composer).

**Abort state machine** (claude-code-webui precedent): idle → composer shows
"send"; streaming → status line appears (working text + elapsed), send button
becomes mode-aware (steer/follow-up), ■ stop appears; stop → `abort`, status
line shows "stopping…" until `agent_end`. Stop is never shown when idle.

**Live tool calls.** `tool_execution_start` opens a tool card in running
state (status colored, elapsed timer); `update` streams partial output;
`end` finalizes (result body, or error styling). Cards are `<details>`;
default collapsed except the currently-running one.

**Task list.** `tasks_update` replaces the dock panel contents; ☐/⧖/☑
glyphs; panel summary line shows "n of m done".

**Suggest-next.** `suggest_next` renders a suggestion chip in the composer
row; tab (desktop) or tap inserts into the composer. Ghost text inside the
textarea is not used — a separate chip is unambiguous on touch.

**Extension UI.** Blocking requests (`select`/`confirm`/`input`/`editor`)
render as modals over the session view; timeouts auto-resolve server-side and
close the modal; dismiss sends `cancelled: true`. Fire-and-forget methods:
`notify` → toasts (status-colored), `setStatus` → keyed status-line entries,
`setWidget` → text blocks above/below composer, `setTitle` → document.title,
`set_editor_text` → composer prefill.

**Errors.** `stream_retry`/`auto_retry` → status line warnings with attempt
counts. Terminal failures set the session's error status (✕ chip, fleet card
border, needs-attention). `modelFallbackMessage` from `get_state` → dismissible
warning banner in the session view.

## 6. Security UX — exactly two modes

Per the maintainer's clarification on issue 307 there are **two** operating
modes. There is no LAN mode; the design must never present one.

**Mode A — local-only (default).** Server binds loopback only (`127.0.0.1` /
`::1`). Works with no Tailscale installed; LAN packets never reach the
process. No login, no pairing. UI shows a plain-chip badge: `⌂ local ·
127.0.0.1`. Settings → devices lists the host as "this machine · local ·
always allowed."

**Mode B — remote (opt-in).** Requires Tailscale. Enforcement layers, in
order, all fail-closed (carried forward from closed draft PR 310's endorsed
auth design): (1) Tailscale network reachability, (2) identity/device
allowlist — non-allowed identities get a denial page naming the rejected
identity, (3) first-login PIN pairing — short-lived (5 min), single-use,
displayed only in the host terminal, (4) signed per-device cookie thereafter.
UI badge: `⇄ remote · <device> via tailscale`. Every paired device is listed
and unpair-able in settings.

**Dangerous-capability copy** (fixed screen copy, verbatim in mockups):

- Pairing grant (`pairing.html`): "This browser gets a signed cookie for this
  host. It can chat with agents, run commands through them, browse project
  files, and upload/download — the same power as sitting at the terminal.
  Unpair anytime from settings → devices."
- PIN rationale (`pairing.html`): "Your network identity got you here, but
  identity alone doesn't grant control. The PIN proves you can see the host
  machine's terminal — so a stolen or shared allowlist entry can't quietly
  gain access."
- Upload (`files.html`): "Uploads land on the host machine and become visible
  to any agent working in this project. Existing files are never overwritten
  silently — you'll be asked first."
- Browse scope (`files.html`): "browsing is scoped to this project — paths
  outside it are not served."

**Server-side constraints the design assumes** (endorsed from PR 310, they are
requirements on the implementation): fail-closed auth middleware (deny on any
auth-subsystem error), path-escape-guarded file APIs (canonicalize, then
prefix-check against the project root), RPC runtime pool keyed by
cwd+session, SSE event fanout. Shell passthrough (§PARITY 3) is sequenced
after the foundation deliberately: it is the rawest control surface and ships
only with the auth layer proven.

## 7. Foundation scope

**The first implementation PR must establish:**

1. Dashboard server: loopback bind default, remote mode behind explicit
   opt-in flag; fail-closed auth (allowlist + PIN + device cookies); SSE
   event pipeline from pooled RPC runtimes; path-guarded file endpoints.
2. Fleet overview: live cards + on-disk inventory (`list_all_sessions`),
   resume/delete/new, needs-attention sort + badge.
3. Session view: transcript with the full §PARITY 4 entry-type coverage
   (generic fallbacks acceptable for exotic tool bodies), streaming render,
   composer with steer/follow-up/abort, tasks panel, suggest-next chip,
   extension-UI modals, model/thinking switchers.
4. Pairing flow + settings tab (defaults + devices).
5. The visual language: `tokens.css` adopted as-is; fixed light/dark via
   `prefers-color-scheme` (**decision:** the MVP does not follow TUI themes —
   the TUI-theme→CSS bridge (`getResolvedThemeColors`) exists and export-html
   proves it, but theme-following multiplies visual QA surface; it is
   explicitly later work).

**Sequenced later (non-blocking):** files tab full UX (browse ships, polish
later), tree screen (RPC is ready; navigation via re-edit covers the primary
loop meanwhile), shell passthrough, scoped-models UI, multi-select copy,
extension custom-tool ANSI bridge, tree label editing, browser notifications
beyond tab badge, TUI-theme following.

Anything in "later" must degrade to an honest absence (no dead buttons).

## 8. Frontend architecture recommendation

**Recommendation: SolidJS + Vite, TypeScript, hand-written CSS from
`tokens.css`. Server: Express + `RpcClient` from `@dreb/coding-agent/rpc`.**

Rationale:

- **Fine-grained reactivity matches the workload.** The dashboard is an
  event-stream reducer: SSE events mutate session state maps; signals update
  exactly the affected DOM (a streaming `message_update` touches one text
  node, not a component subtree). Solid's model does this without
  memo/callback discipline, and no VDOM diffing on every token.
- **Small and auditable.** ~7KB runtime, no build-time magic beyond JSX;
  compatible with issue 307's "small enough to reason about security"
  constraint. Precedent: opencode-web.
- **Real components + dev server** close PR 310's actual failure mode
  (hand-rolled DOM, full re-render, no iteration loop) without adopting a
  heavy framework.

Rejected alternatives:

- **React 19 + Vite** — strongest in-house precedent (mDraft: production
  Express + dreb-RpcClient + SSE + React). Viable, but its re-render model is
  the wrong default for token streams (needs careful memoization where Solid
  needs nothing), and the dependency graph is an order of magnitude larger.
  If the implementer's velocity in React decisively outweighs that, this is
  the sanctioned fallback — the server design and all UX in this spec are
  framework-agnostic.
- **Svelte 5** — comparable size/reactivity; rejected on precedent: no
  existing Svelte codebase in-house or in the researched dashboard ecosystem,
  and runes are a second new mental model.
- **Vanilla/hand-rolled** — what PR 310 tried; failed on architecture
  (no components, no reactivity). Rejected.
- **Tailwind / shadcn / component kits** — rejected. `tokens.css` is ~450
  lines and *is* the design system; utility-class frameworks bring the
  aesthetic homogenization the anti-slop constraint exists to prevent, and
  third-party component CSS is unauditable against the token contract.
- **Zero-dependency node:http server (PR 310's choice)** — worked, but
  Express + `RpcClient` is mDraft-proven, and middleware composition (auth,
  SSE, path guards) is where node:http hand-rolling gets error-prone.
  Express's cost is negligible against the security-review benefit of
  boring, well-known middleware patterns.

**What static mockups cannot validate** (flagged for implementation-phase
validation, not settled by this design): token-by-token streaming feel
(batching/throttling policy), fleet-grid live reordering as attention states
change (must not jump under the user's finger), SSE reconnect/catch-up UX,
composer mode-switch latency while streaming, and modal focus management
under rapid extension requests.

## 9. Acceptance criteria for the implementation PR

1. **Modes:** loopback-only by default (no Tailscale required, no LAN
   reachability); remote mode requires Tailscale + allowlist + PIN pairing +
   device cookies, fail-closed on every auth path. No third mode exists.
2. **Fleet:** groups by project; live cards show status chip (glyph+color),
   activity line, live subagents, tasks progress, ctx%, model, last-activity;
   needs-attention sorts first and badges the tab; on-disk inventory lists,
   resumes, and deletes sessions across projects.
3. **Session view:** renders every §PARITY 4 ✅ entry type; streams live;
   composer implements steer/follow-up exactly as §5 defines them; ■ stop
   appears only while streaming and aborts; queued messages are visible and
   dequeueable; tasks panel and suggest-next chip work; extension UI requests
   render as §5 modals and answer over RPC; model and thinking switchers work.
4. **Parity:** every PARITY.md ✅ row is implemented or the row is re-dispositioned
   in the same PR (PARITY.md updated — no silent scope shrink). 🔜/❌ rows
   have no dead UI.
5. **Files:** browse/download/upload scoped to project roots with the §6
   warning copy; path escape attempts rejected server-side and tested.
6. **Settings:** reads live+default state, writes defaults, surfaces RPC
   validation errors verbatim; devices list with unpair.
7. **Pairing:** PIN flow matches `pairing.html` including the two security
   copy blocks; PINs are single-use, expiring, terminal-displayed.
8. **Visual language:** `tokens.css` adopted unmodified (extensions allowed,
   overrides are a design change requiring this spec's update); IBM Plex Mono;
   light+dark; no additional colors beyond the four status accents; WCAG AA
   contrast for text and status pairings.
9. **Non-goals honored:** no TUI-theme following, no shell passthrough, no
   OAuth flows, no session import (§PARITY dispositions) in the foundation PR.
10. **Tests:** auth (fail-closed paths), file path guards, SSE
    reducer/state-map correctness, and composer mode dispatch have unit
    coverage; the six screens have at least smoke-level render tests.
