# dreb Dashboard — Design Spec

UX/UI specification for the dreb web dashboard (implementation issue 307,
design issue 311). Companion artifacts in this directory:

- `tokens.css` — design tokens + shared primitives (the visual language, enforced in code)
- `mockups/*.html` — seven static screens sharing `tokens.css`
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
 │      └─→ subagent view (read-only drill-in, per background agent)
 ├─→ files tab (host-wide browse/upload/download/new-folder)
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
| Files | `files.html` | Host-wide filesystem browse (places shortcuts, breadcrumbs to `/`), new-folder, download, drop-zone upload, "new session here" |
| Settings | `settings.html` | Persistent defaults (get/set_settings surface: model, thinking, queue modes, compaction/retry toggles) + current pairing code + paired-devices management |
| Pairing | `pairing.html` | Remote first-login: identity echo, rotating 6-digit code, "why a PIN" + "what pairing grants" copy |
| Subagent view | `subagent-view.html` | Read-only live drill-in to a background subagent's session: task, transcript, tool activity, status; no composer (see §5a) |

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
identity that was rejected. User enters the current 6-digit rotating code shown
in the dashboard Settings tab on the host machine (the code rotates every 30
seconds; the server also prints the current code at startup for headless use).
Success sets a signed device cookie and lands on the fleet. The device appears
in settings → devices with unpair.

**Project selection / new session.** "+ new session" (global or per-project
header) → modal: project path (recent projects listed; free-text path entry),
optional first prompt. Creates a runtime via `new_session`, navigates into it.

**Resume.** On-disk row "resume" → promotes to live runtime (`switch_session`
on a pooled runtime), navigates into the session view with history hydrated
via `get_messages`.

**Chat.** §5. **Subagent monitoring.** §5a.

**File transfer.** Files tab browses the **whole host filesystem** — the
dashboard is a trusted-operator surface (§6), and real workflows need
out-of-project paths: downloading something an agent wrote to `/tmp`,
creating a fresh folder *before* starting a session in it ("new session
here" on any directory), grabbing artifacts from another project. "Places"
chips jump to home, `/tmp`, and known project roots. New-folder and upload
live on every directory. Downloads stream from the server. Uploads via
drop-zone or picker; collision prompts before overwrite. Warning copy is
fixed on the screen, not a dismissible toast (`files.html`). Server-side,
path handling still canonicalizes and rejects traversal trickery — the
boundary is "what the dreb process can read as its Unix user," enforced
honestly, not a pretend jail.

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
| Files | Table with size/modified columns; places + actions inline | Size/modified columns hidden; name + download only; action buttons wrap full-width |
| Subagent view | Same transcript layout as session view | Same reductions as session view; status stays in bar |
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

Queued messages render as chips above the composer (dequeue = TUI `alt+up`);
the foundation restores the queued batch to the composer because RPC exposes
`clear_pending_messages` as a batch operation, matching the TUI shortcut.

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

## 5a. Subagent observability

Three levels, all designed now; the third has an implementation gap that the
implementation PR must close **architecturally, not by hacking around it**:

1. **Fleet card** (`fleet-overview.html`): running/done counts + live agent
   lines per session, driven by `background_agent_start`/`end` events.
2. **Session subagent strip** (`session-view.html`): one chip per background
   agent (● running / ✓ done, task summary), sitting above the status line.
   Clicking a chip drills into that subagent's session.
3. **Subagent drill-in view** (`subagent-view.html`): a read-only live
   session view — parent task as the first entry, streaming transcript, tool
   cards, elapsed/status in the bar. **No composer.** A fixed note explains:
   "viewing live — subagents can't be steered yet; the parent session
   controls this agent."

**The RPC gap (implementation-PR scope).** Today the only external trace of
a background subagent is its session JSONL under the subagent-sessions dir
(`getSubagentSessionsDir()`), discovered *after* exit by `discoverSessionFile()`
— and the parent's `background_agent_start` event carries only
`agentId`/`agentType`/`taskSummary`, **not** the session path or PID. The
child *does* stream JSONL events on stdout, but the parent consumes them
privately in `executeSingle()` and throws them away after extracting
progress lines. Tailing session files off disk would work for a demo and is
rejected here: it's polling, it races the writer, and it has no path to
bidirectional control (steering) later.

What the implementation PR must add instead — the sane architecture:

- **Registry exposure:** extend `BackgroundAgentInfo` with the child's
  session file path (derivable at spawn time — the parent creates
  `sessionDir` itself) and surface the registry over RPC: a
  `list_background_agents` command, and `background_agent_start` events
  enriched with the session path.
- **Event relay:** the parent already parses every child JSONL event in
  `executeSingle()`'s stdout reader; add an opt-in relay so those events are
  re-emitted (namespaced by `agentId`) on the parent's event stream. The
  dashboard server then fans them out over the same SSE pipeline as parent
  events — one transport, no file tailing, no polling.
- **Steering (future, not MVP):** the relay's control-channel mirror.
  Subagent stdin is currently `"ignore"`; steering means opening it and
  forwarding a `steer` command down — the event relay establishes the
  addressing (`agentId`-scoped) that this will reuse. The drill-in view's
  read-only note is replaced by a composer at that point, and *only* at
  that point (no dead composer in the MVP).

MVP acceptance for this section: levels 1–2 fully live; level 3 renders the
live transcript via the event relay (read-only). If the relay slips, the
drill-in view must not ship half-done — a chip with no click target is
honest; a broken viewer is not.

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
identity, (3) first-login pairing code — 6 digits, rotating every 30 seconds,
displayed only in the host/local dashboard Settings tab (with a startup stdout
fallback), (4) signed per-device cookie thereafter. UI badge: `⇄ remote ·
<device> via tailscale`. Every paired device is listed and unpair-able in
settings.

**Dangerous-capability copy** (fixed screen copy, verbatim in mockups):

- Pairing grant (`pairing.html`): "This browser gets a signed cookie for this
  host. It can chat with agents, run commands through them, browse the host's
  files, and upload/download — the same power as sitting at the terminal.
  Unpair anytime from settings → devices."
- PIN rationale (`pairing.html`): "Your network identity got you here, but
  identity alone doesn't grant control. The code proves you can see the host
  machine's local dashboard — so a stolen or shared allowlist entry can't
  quietly gain access."
- Upload (`files.html`): "Uploads land on the host machine and become visible
  to any agent working near this path. Existing files are never overwritten
  silently — you'll be asked first."
- Browse scope (`files.html`): "whole host filesystem — you can browse
  anywhere the dreb process can read."

**Server-side constraints the design assumes** (endorsed from PR 310, they are
requirements on the implementation): fail-closed auth middleware (deny on any
auth-subsystem error), canonicalized path handling in the file APIs — the
files surface is deliberately host-wide (trusted-operator model: a paired
device already equals terminal access, so a project jail would be security
theater), but paths are still canonicalized, symlink-resolved, and
percent-decode-checked so the *API* can't be confused, and every file
operation is logged server-side. RPC runtime pool keyed by cwd+session, SSE
event fanout. Shell passthrough (§PARITY 3) is sequenced after the
foundation deliberately: it is the rawest control surface and ships only
with the auth layer proven.

## 7. Foundation scope

**The first implementation PR must establish:**

1. Dashboard server: loopback bind default, remote mode behind explicit
   opt-in flag; fail-closed auth (allowlist + PIN + device cookies); SSE
   event pipeline from pooled RPC runtimes; canonicalized host-wide file
   endpoints (browse, download, upload, mkdir).
2. Fleet overview: live cards + on-disk inventory (`list_all_sessions`),
   resume/delete/new, needs-attention sort + badge, per-session subagent
   counts and live lines.
3. Session view: transcript with the full §PARITY 4 entry-type coverage
   (generic fallbacks acceptable for exotic tool bodies), streaming render,
   composer with steer/follow-up/abort, tasks panel, suggest-next chip,
   extension-UI modals, model/thinking switchers, subagent strip.
4. Subagent observability (§5a): registry over RPC + event relay + read-only
   drill-in view. The relay is foundation work because it defines the
   addressing model that future subagent steering reuses — bolting it on
   later would mean a second transport.
5. Files tab: host-wide browse with places, new-folder, upload/download,
   "new session here".
6. Pairing flow + settings tab (defaults + devices).
7. The visual language: `tokens.css` adopted as-is; fixed light/dark via
   `prefers-color-scheme` (**decision:** the MVP does not follow TUI themes —
   the TUI-theme→CSS bridge (`getResolvedThemeColors`) exists and export-html
   proves it, but theme-following multiplies visual QA surface; it is
   explicitly later work).

**Sequenced later (non-blocking):** tree screen (RPC is ready; navigation via
re-edit covers the primary loop meanwhile), shell passthrough, scoped-models
UI, multi-select copy, extension custom-tool ANSI bridge, tree label editing,
notification refinements beyond the shipped hidden-tab needs-attention
Notification API + tab-title badge, TUI-theme following, **subagent steering**
(§5a — requires child stdin control channel; the event relay ships first and
defines its addressing).

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
   reachability); remote mode requires Tailscale + allowlist + rotating-code
   pairing + device cookies, fail-closed on every auth path. No third mode exists.
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
5. **Files:** host-wide browse with places shortcuts, new-folder, "new
   session here", download/upload with the §6 warning copy; paths are
   canonicalized (symlink/percent-decode confusion rejected and tested);
   file operations logged server-side.
6. **Subagents:** fleet cards and the session strip show live subagent
   state from `background_agent_start`/`end`; the drill-in view renders a
   subagent's live transcript read-only via the §5a event relay;
   `list_background_agents` (or equivalent registry exposure) exists over
   RPC with session paths; no composer is present in the subagent view.
7. **Settings:** reads live+default state, writes defaults, surfaces RPC
   validation errors verbatim; devices list with unpair and the current
   rotating pairing code on the host/local dashboard.
8. **Pairing:** rotating-code flow matches `pairing.html` including the two
   security copy blocks; codes are host/local-visible and rotate every 30s.
9. **Visual language:** `tokens.css` adopted unmodified (extensions allowed,
   overrides are a design change requiring this spec's update); IBM Plex Mono;
   light+dark; no additional colors beyond the four status accents; WCAG AA
   contrast for text and status pairings.
10. **Non-goals honored:** no TUI-theme following, no shell passthrough, no
    OAuth flows, no session import, no subagent steering (§PARITY
    dispositions, §5a) in the foundation PR.
11. **Tests:** auth (fail-closed paths), file path canonicalization, SSE
    reducer/state-map correctness, subagent event relay, and composer mode
    dispatch have unit coverage; the seven screens have at least smoke-level
    render tests.
