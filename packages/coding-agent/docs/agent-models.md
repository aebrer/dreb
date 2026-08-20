# Agent Model Settings

Configure per-agent model overrides for subagents via settings, without editing agent definition files.

## What it does

The `agentModels.models` setting lets you override the default model used by each subagent type (e.g., Explore, Sandbox) without modifying the agent definition `.md` files. You can specify an ordered fallback list — the first available model is used.

This applies to all subagents, including those launched by the mach6 skill workflow.

## Configuration

Add to your `~/.dreb/agent/settings.json`:

```json
{
  "agentModels": {
    "models": {
      "Explore": ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"],
      "Sandbox": ["anthropic/claude-haiku-3-20250422"]
    }
  }
}
```

Each key is an agent type name, and the value is an ordered list of model IDs (in `provider/model` format). Project-level settings (`.dreb/settings.json`) are merged over global settings.

## Resolution Order

When a subagent is launched, its model is resolved in this priority:

1. **Per-invocation `model` override** — highest priority, set explicitly in the subagent tool call
2. **`agentModels.models` setting** — from your settings.json, per agent type
3. **Agent definition `model` field** — from the `.md` agent file's frontmatter
4. **Parent session model** — used when none of the above resolve to an available model

If the `agentModels.models` list is empty or undefined for a given agent, resolution falls through to the agent definition's model, then to the parent session model.

## Per-request Thinking Overrides

The `subagent` tool accepts an optional `thinking` value in single mode, at the top level for parallel/chain inheritance, or on an individual task/step. Per-task values win over the top-level value.

Supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Validation happens after the child model resolves: non-`off` levels fail for non-reasoning models, `xhigh` requires advertised xhigh support, and `max` requires a max-capable model (currently GPT-5.6 including Sol, Terra, and Luna). `max` does not replace `xhigh`. Codex `ultra` additionally enables client-side multi-agent orchestration, so it is not accepted or sent as a raw effort. Omit the field to preserve the child's normal default/settings behavior. The child's actual effective level is reported in its `agent_start` event, result metadata, and `background_agent_end` event.

## Evidence-based Routing Guide

The built-in `/skill:model-routing-guide` workflow has exactly two scope sources: non-empty comma-separated skill arguments, or the effective non-empty `enabledModels` array when invoked without arguments. Once it selects either source, it treats that list as authoritative and does not search for another session scope.

Because Stage 1 is a skill-only workflow, it cannot discover a session's runtime `--models` value or later in-session scope changes. Pass the same patterns as skill arguments when that runtime scope is the intended research set. The workflow resolves candidates against `dreb --list-models`, combines canonical provider/model documentation and public evidence with sanitized aggregate observations from local subagent session logs, then writes and validates `~/.dreb/agent/model-routing-guide.md`.

The guide is intended to improve role and cost fit, especially keeping planning/implementation work out of `Explore` and reserving expensive frontier models for work that actually needs them. Guide generation alone does not change routing; the optional Dispatch Arbiter below consumes it. See [skills.md](skills.md#model-routing-guide).

## Dispatch Arbiter

`subagentArbiter` is an opt-in, global-only pre-spawn control. Users configure it through interactive `/settings`, dashboard Settings, global `settings.json`, or the RPC settings API; both normal UIs expose enable/disable, exact model, thinking, guide path, and loud readiness/validation feedback. Project settings cannot shadow any field. The normal resolution order above first produces one concrete proposal. The arbiter then runs once before each actual child spawn—single, every parallel item, and every chain step after `{previous}` substitution—and returns exactly:

```json
{"agent":"feature-dev","model":"provider/model-id","thinking":"high"}
```

The host accepts only those three exact fields. The agent must already be available through the parent's `subagent` tool, the model must be an exact canonical member of the current live explicit scope, and thinking must be supported by that model. The selected existing definition supplies its system prompt and filtered tool configuration verbatim. Task, cwd, chain-substituted content, parent linkage, and every non-routing field remain unchanged.

The arbiter follows the tab/session-title setter's small headless pattern: `AgentSession` maintains a bounded `RollingContextBuffer`, then the control path makes a direct `completeSimple()` call with the configured model/API key, timeout, and no tools or child process. There is no parent-model fallback. One malformed JSON response may be retried once; all configuration, guide, scope, auth/provider, timeout, parse, agent, model, and thinking failures prevent spawn.

The validated input contains the immutable task/cwd, proposed route, safe summaries of all available definitions (name, description, effective tools, model defaults), exact live candidates, the matching guide, bounded first/latest user intent and recent labeled parent activity—including bounded tool outputs—parent model/session title, metadata-only repository/cwd/branch/dirty count, and lineage identifiers. Following the title setter's rolling-context pattern, ordinary file contents, diffs, command output, and other useful tool-result content are not categorically removed; the serialized package receives the existing secret scrubbing before remote inference. The arbiter itself receives no tools. The child still receives the original unsanitized task/cwd exactly as provided.

Every enabled attempt emits and persists a safe `subagent_arbitration` record with proposed/final routes, changed fields, success/failure, optional chain step, and host-generated errors. Raw arbiter prompt/output/reasoning is never persisted or inserted into either model context. The TUI, JSON/RPC, and dashboard consume the same typed record; dashboard agent identity updates to the final selected agent before child events arrive.

Configuration and failure details are in [settings.md](settings.md#dispatch-arbiter); event shapes are in [json.md](json.md) and [rpc.md](rpc.md).

## Parent Model Identity in System Prompt

The **parent session's** running model is exposed in its own system prompt as:

```
You are running on: provider/id
```

This lets the parent model make self-aware routing decisions — e.g. delegating vision tasks if it's on a text-only model, or explicitly requesting a differently-architected model as a critic when diverse perspectives improve reliability. The identity line updates automatically whenever the user switches models mid-session.

## TUI Usage

Open `/settings` and select the **Agent Models** submenu. Each discovered agent type gets its own entry where you can:

- **Reorder** models (move up/down to set priority)
- **Add** new models from the available model list
- **Remove** models from the fallback list

Changes are saved to your global settings immediately.

## Example

```json
{
  "agentModels": {
    "models": {
      "Explore": [
        "openai/gpt-4o-mini",
        "anthropic/claude-haiku-3-20250422"
      ]
    }
  }
}
```

This configures the Explore agent to prefer `gpt-4o-mini`, falling back to `claude-haiku` if the first isn't available. All other agents use their default models.
