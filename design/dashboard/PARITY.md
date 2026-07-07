# TUI Feature Parity Checklist

Every dreb TUI capability, mapped to a dashboard equivalent or explicitly marked
out of scope with a reason. This file is the authority for parity coverage; the
inventory was re-verified against source (2026-07-07, branch
`feature/issue-311-dashboard-ux-design`), not taken from the issue assessment's
estimates. Where the counts differ from the assessment, source wins.

**Ground-truth counts** (vs. assessment estimates):

| Surface | Assessment | Verified | Source of truth |
|---|---|---|---|
| Built-in slash commands | 26 | **21** (+2 hidden easter eggs) | `core/slash-commands.ts` `BUILTIN_SLASH_COMMANDS`; dispatch in `interactive-mode.ts` |
| Keybound behaviors | ~35 | **~74** (incl. per-modal and component-local bindings) | `docs/keybindings.md` + `matchesKey()` literals in components |
| Message-stream component types | 9 | **15** core + tool sub-matrix + 3 easter eggs | `interactive-mode.ts` `addMessageToChat()`; `components/*` |
| Session-level event types | 9 | **21** (12 AgentEvent + 9 session) + `extension_error` on the RPC wire | `agent-session.ts:132`; `packages/agent/src/types.ts` |
| RPC commands | — | **40** | `modes/rpc/rpc-types.ts`, `docs/rpc.md` |
| TUI-only affordances | ~15 | **19** | see section 7 |

Disposition legend:
- ✅ **dashboard** — has a designed equivalent (mockup/spec reference given)
- 🔜 **later** — in scope for the dashboard, sequenced after the foundation (SPEC.md §Foundation)
- ❌ **out** — out of scope, with reason
- ⚙️ **RPC gap** — needs a new RPC command before implementable (none block the foundation)

---

## 1. Built-in slash commands (21 + 2 hidden)

The dashboard deliberately has **no command line**. Slash commands are a
TUI input idiom; the dashboard maps each command's *outcome* to a UI control.
(Extension commands, skills, and prompt templates — which arrive over RPC
`get_commands` — do get a typed-command affordance in the composer; see §2.)

| Command | Disposition | Dashboard equivalent |
|---|---|---|
| `/settings` | ✅ dashboard | Settings tab (`mockups/settings.html`) via `get_settings`/`set_settings` |
| `/model [search]` | ✅ dashboard | Model switcher in session bar (`mockups/session-view.html`), searchable selector modal; `get_available_models` + `set_model` |
| `/scoped-models` | 🔜 later | Needs settings-file keys beyond `set_settings`'s current surface; model switcher ships first, scoping UI follows |
| `/export [path]` | ✅ dashboard | "export HTML" in session ⋯ overflow menu → `export_html`, served as download. JSONL export: ❌ out — `path` variant has no RPC surface; the session file itself is downloadable via Files |
| `/import <path.jsonl>` | ❌ out | No RPC surface; import is a host-filesystem operation. Workaround: place file in sessions dir from Files tab, then resume |
| `/copy` | ✅ dashboard | Per-message copy button (browser clipboard API); multi-select copy 🔜 later |
| `/name <name>` | ✅ dashboard | Rename affordance in session ⋯ menu → `set_session_name` |
| `/session` | ✅ dashboard | Session bar ctx% + stats popover → `get_session_stats`, `get_performance_stats` |
| `/changelog` | ❌ out | TUI/product-update concern; release notes live on GitHub. Dashboard shows version in footer |
| `/hotkeys` | ❌ out | No keyboard-modal interface to document. Dashboard keyboard shortcuts (if any) documented inline |
| `/fork` | ✅ dashboard | Fork from any user message (message hover action) → `get_fork_messages` + `fork` |
| `/tree` | 🔜 later | Tree screen fully designed (`mockups/tree.html`) → `get_tree` + `navigate_tree`; sequenced after the foundation (SPEC.md §7) — fork covers the go-back-and-re-edit loop meanwhile |
| `/login` | ❌ out | OAuth flows open browsers and store host credentials; running them from a remote browser is a credential-exfiltration hazard. Do on the host TUI |
| `/logout` | ❌ out | Same reason as `/login` |
| `/new` | ✅ dashboard | "+ new session" (fleet, `mockups/fleet-overview.html`) → `new_session` |
| `/compact [instructions]` | ✅ dashboard | "compact now" in session ⋯ menu → `compact` (with optional instructions field) |
| `/dream` | ❌ out | Memory consolidation is a host-side maintenance job with interactive confirmation flow; no RPC surface. Run from TUI |
| `/resume` | ✅ dashboard | Fleet on-disk inventory "resume" → `switch_session` (`mockups/fleet-overview.html`) |
| `/reload` | ❌ out | Reloads the host process's extensions/keybindings/themes; meaningless per-browser-client. Restart runtime 🔜 later as a fleet action if needed |
| `/buddy` | ❌ out | Terminal companion easter egg; `buddy_hatch`/`buddy_reroll` exist over RPC but the pet renders in terminal cells. Not a dashboard surface |
| `/quit` | ✅ dashboard | Per-session "stop runtime" (fleet ⋯ menu) — dashboard server manages runtime lifecycle; browser never kills the server itself |
| `/debug` (hidden) | ❌ out | TUI render-state dump; dashboard debugging uses browser devtools |
| `/arminsayshi` (hidden) | ❌ out | Terminal easter egg |

## 2. Extensibility command surfaces

| Surface | Disposition | Dashboard equivalent |
|---|---|---|
| Extension commands (`dreb.registerCommand`) | ✅ dashboard | Composer `/` autocomplete fed by `get_commands` (source: extension); sent as prompt text, executes server-side |
| Skills (`/skill:name args`) | ✅ dashboard | Same autocomplete (source: skill); expanded server-side by `AgentSession` |
| Prompt templates (`/name args`) | ✅ dashboard | Same autocomplete (source: prompt) |
| Built-ins in autocomplete | ❌ out | `get_commands` deliberately excludes built-ins; dashboard maps their outcomes to UI controls (§1), so listing them as typed commands would duplicate the UI |

## 3. Keybound behaviors (~74)

The TUI's keyboard surface collapses into a handful of dashboard interaction
groups. Editor-internal keys (cursor movement, kill ring, undo, jump-to-char —
~25 bindings) are native `<textarea>`/browser behavior and are not re-listed.

| TUI behavior group | Disposition | Dashboard equivalent |
|---|---|---|
| Submit (`enter`) / newline (`shift+enter`) | ✅ dashboard | Composer send button + same key pair (`mockups/session-view.html`) |
| Steer (submit while streaming) | ✅ dashboard | Composer mode toggle "steer" — explicit, not implicit (`session-view.html`) |
| Follow-up queue (`alt+enter`) | ✅ dashboard | Composer mode toggle "follow-up" |
| Dequeue (`alt+up`) | ✅ dashboard | Queued-message chips above composer with per-item dismiss/edit (spec §Interaction) |
| Abort (`escape`) | ✅ dashboard | ■ stop button, visible only while streaming (`session-view.html`) |
| Double-escape → tree/fork | ✅ dashboard | Fork actions are first-class (message hover); tree screen 🔜 later (§1 `/tree`); no gesture needed |
| Abort compaction/retry/dream (`escape` variants) | ✅ dashboard | Status line shows compaction/retry state with its own stop affordance |
| Model cycling / selector | ✅ dashboard | Model switcher in session bar → selector modal |
| Thinking cycling (`shift+tab`) | ✅ dashboard | Thinking switcher in session bar |
| Tool output expand/collapse (`ctrl+o`, global) | ✅ dashboard | Per-tool-card `<details>` + "expand/collapse all" in ⋯ menu |
| Thinking visibility (`ctrl+t`) | ✅ dashboard | Per-thinking-block `<details>` (collapsed default) |
| Tasks panel toggle | ✅ dashboard | Tasks panel is collapsible in dock (`session-view.html`) |
| Session new/tree/fork/resume keys | ✅ dashboard | First-class UI (fleet, message actions); tree screen 🔜 later (§1 `/tree`) |
| Session selector: sort/filter/rename/delete keys | ✅ dashboard | Fleet on-disk list with actions; sort/filter controls 🔜 later ("all N on disk" screen) |
| Tree selector: filter modes (`ctrl+d/t/u/l/a/o`), fold/unfold, label editing | 🔜 later | Tree screen filter chips (designed, `tree.html`); follows the §1 `/tree` sequencing. Label *editing* additionally needs a label-only RPC ⚙️ for non-navigation labeling (`navigate_tree` label param exists) |
| Copy messages (`ctrl+shift+c`, multi-select) | 🔜 later | Per-message copy first; multi-select copy screen later |
| Image paste (`ctrl+v`) | ✅ dashboard | Browser-native paste/attach in composer (spec §Interaction; `prompt` RPC carries images) |
| External editor (`ctrl+g`) | ❌ out | `$EDITOR` is a host-terminal concept; the browser composer *is* the editor |
| Shell passthrough (`!` / `!!`) | 🔜 later | RPC `bash`/`abort_bash` exist; deliberately sequenced after foundation because it's the highest-risk control surface (spec §Security) |
| Suspend (`ctrl+z`) | ❌ out | POSIX job control; no browser meaning |
| History browse (up/down in empty editor) | ✅ dashboard | Composer up/down through this session's sent prompts |
| Scoped-models selector keys | 🔜 later | Follows `/scoped-models` disposition |
| OAuth selector keys | ❌ out | Follows `/login` disposition |
| Debug dump (`shift+ctrl+d`) | ❌ out | Browser devtools |
| Editor-internal cursor/kill-ring/undo (~25 keys) | ✅ dashboard | Native browser text editing |

## 4. Message-stream component types (15 + tool matrix)

The chat pane renders every entry type the export-html renderer knows
(`core/export-html/template.js` `renderEntry()`), adapted live. Mockup:
`mockups/session-view.html`.

| Component | Disposition | Dashboard treatment |
|---|---|---|
| User message | ✅ dashboard | Right-set hairline box, markdown |
| Assistant message (text + thinking blocks in order) | ✅ dashboard | Plain page text; thinking as collapsed `<details>` |
| Tool execution (call + merged result) | ✅ dashboard | Hairline card: name + arg summary + status, collapsible result |
| — tool sub-matrix: `read`/`write`/`edit`/`bash` bespoke bodies | ✅ dashboard | Per-tool formatting; `edit` renders diff with status colors |
| — `grep`/`find`/`ls`/`search`/`web_*`/`subagent`/`skill`/`tasks_update`/`wait`/`suggest_next` | ✅ dashboard | Name + arg summary headers; result bodies start generic (pre) and get bespoke treatment incrementally |
| — extension custom tools (`renderCall`/`renderResult` are TUI/ANSI renderers) | 🔜 later | Foundation renders generic JSON; ANSI→HTML bridge (like `tool-renderer.ts` does for export) later |
| Bash execution (`!` passthrough entries) | ✅ dashboard | Rendered like a bash tool card with "user-run" tag (read-only until §3 shell passthrough ships) |
| Custom message (`role: custom`, extension-injected) | ✅ dashboard | Bordered card with extension tag; custom TUI renderers fall back to text |
| Compaction summary | ✅ dashboard | Full-width collapsed summary card (`session-view.html`) |
| Branch summary | ✅ dashboard | Same card treatment, "branch" label |
| Skill invocation (parsed from user message) | ✅ dashboard | User message variant with skill-name header |
| Inline working status / spinner | ✅ dashboard | Status line in dock: working text + elapsed + stop |
| Transient status lines (`showStatus`) | ✅ dashboard | Toast row above dock, auto-expiring |
| Auto-compaction loader | ✅ dashboard | Status line variant ("compacting — esc to abort" → stop button) |
| Auto-retry loader | ✅ dashboard | Status line variant with attempt count, warning color |
| Tasks panel (`tasks_update`) | ✅ dashboard | Collapsible dock panel (`session-view.html`) |
| Ghost-text suggestion (`suggest_next`) | ✅ dashboard | Suggestion chip in composer row, tab/tap to accept |
| BorderedLoader (blocking, `/reload`) | ❌ out | `/reload` is out; extension blocking UI uses modals (§6) |
| Buddy / Armin / Daxnuts components | ❌ out | Terminal easter eggs |

## 5. Session-level events (21 + `extension_error`)

How each streamed event drives the UI. Transport: SSE from the dashboard
server, which subscribes via RPC (spec §Architecture).

| Event | Disposition | Dashboard treatment |
|---|---|---|
| `agent_start` / `agent_end` | ✅ dashboard | Session status chip running↔idle; fleet card updates |
| `turn_start` / `turn_end` | ✅ dashboard | Ignored (TUI ignores them too); available for future turn markers |
| `message_start` / `message_update` / `message_end` | ✅ dashboard | Streaming text/thinking into the newest entry (token cursor in `session-view.html`) |
| `tool_execution_start` / `update` / `end` | ✅ dashboard | Tool card lifecycle: running status → result body |
| `stream_retry` / `length_retry` | ✅ dashboard | Status line warning ("stream dropped, retrying n/m"); discarded partial removed |
| `auto_compaction_start` / `end` | ✅ dashboard | Status line + compaction summary entry on completion |
| `auto_retry_start` / `end` | ✅ dashboard | Status line with attempt/backoff |
| `background_agent_start` / `end` | ✅ dashboard | Fleet card counts/lines + session subagent strip + read-only drill-in view (`fleet-overview.html`, `session-view.html`, `subagent-view.html`). Live transcript needs the §5a event relay (⚙️ RPC gap, implementation-PR scope); subagent *steering* is future work gated on a child control channel |
| `parent_paused_for_background_agents` | ✅ dashboard | Status line ("paused — waiting on N background agents") |
| `tasks_update` | ✅ dashboard | Tasks dock panel |
| `suggest_next` | ✅ dashboard | Composer suggestion chip |
| `extension_error` (RPC wire) | ✅ dashboard | Toast, error-styled |
| `extension_ui_request` / `response` | ✅ dashboard | §6 modals |

## 6. Extension UI requests (9 methods)

| Method | Disposition | Dashboard treatment |
|---|---|---|
| `select` | ✅ dashboard | Modal with option list (modal primitives in `tokens.css`, shown in `tree.html`) |
| `confirm` | ✅ dashboard | Modal yes/no |
| `input` | ✅ dashboard | Modal single-line input |
| `editor` | ✅ dashboard | Modal textarea |
| `notify` | ✅ dashboard | Toast (info/warning/error styling via status colors) |
| `setStatus` | ✅ dashboard | Keyed entries in session status line |
| `setWidget` | ✅ dashboard | Text-block widget above/below composer (string arrays only — RPC protocol limit) |
| `setTitle` | ✅ dashboard | `document.title` |
| `set_editor_text` | ✅ dashboard | Prefill composer |

Requests with timeouts auto-resolve server-side; modals stay dismissible
(sends `cancelled: true`).

## 7. TUI-only affordances (19)

| Affordance | Disposition | Reason / equivalent |
|---|---|---|
| Shell passthrough (`!`/`!!`) | 🔜 later | See §3 — RPC exists, security-sequenced |
| External `$EDITOR` (ctrl+g) | ❌ out | Host-terminal concept |
| Ctrl+Z suspend / job control | ❌ out | POSIX job control |
| Clipboard image paste machinery (xclip/wl-paste/Termux) | ✅ dashboard | Browser Clipboard API replaces the entire mechanism |
| OSC 52 clipboard-over-SSH | ❌ out | Browser Clipboard API is the native equivalent; the protocol itself is meaningless in a browser |
| Kitty/iTerm2 inline terminal images | ✅ dashboard | `<img>` is strictly superior; message images render natively |
| Hardware cursor / IME marker | ❌ out | Browser inputs handle IME natively |
| tmux extended-keys detection + warning | ❌ out | No terminal multiplexer in a browser |
| Kitty keyboard protocol negotiation | ❌ out | Browser key events are unambiguous |
| Key-release events | ❌ out | Browser `keyup` is native |
| Terminal title (OSC 0) + LLM auto-title | ✅ dashboard | `document.title` mirrors session name/status; LLM auto-naming stays host-side |
| Two-zone scrollback rendering | ❌ out | DOM is append-only history natively; the mechanism is terminal-specific |
| Buddy companion | ❌ out | Terminal easter egg (see §1 `/buddy`) |
| Armin/Daxnuts pixel-art easter eggs | ❌ out | Terminal easter eggs |
| Root-user (UID 0) warning | ❌ out | No per-browser meaning; the *host* process warning stays in the TUI/server log |
| Per-terminal-emulator keybinding config docs | ❌ out | Browser keys are consistent |
| Bracketed paste | ❌ out | Browser paste events are atomic natively |
| Termux clipboard bridge | ❌ out | Mobile browsers use the standard Clipboard API |
| Terminal bell/notifications | ✅ dashboard | Browser Notification API for needs-attention (spec §Flows, permission-gated), favicon badge fallback |

## 8. RPC surface not driven by TUI parity

Commands the dashboard uses that have no single TUI-key equivalent:

| RPC | Used by |
|---|---|
| `get_state`, `get_messages` | Session view hydration; `modelFallbackMessage` surfaces as a warning banner |
| `list_sessions`, `list_all_sessions`, `delete_session` | Fleet overview + on-disk inventory |
| `get_tree`, `navigate_tree` | Tree screen (🔜 later, §1 `/tree` — RPC ready) |
| `get_settings`, `set_settings` | Settings tab |
| `get_version` | Footer |
| `get_last_assistant_text` | Fleet card "last activity" previews |
| `buddy_hatch`, `buddy_reroll` | ❌ unused (buddy is out) — note: undocumented in `docs/rpc.md` |

**RPC gaps discovered:** subagent observability is the one **foundation-scope**
gap — `background_agent_start` events carry no session path, the background
registry (`getBackgroundAgents()`) has no RPC command, and child JSONL events
are consumed privately by the parent; the implementation PR must add registry
exposure + an event relay (SPEC.md §5a — file-tailing hacks explicitly
rejected). Non-blocking gaps: label-only tree entries without navigation
(§3); scoped-models/settings keys beyond the current `set_settings` whitelist
(§1); session import (§1). File browse/upload/download is served by the
dashboard server itself (host-wide, canonicalized paths), not by agent RPC —
deliberate, see SPEC.md §6.
