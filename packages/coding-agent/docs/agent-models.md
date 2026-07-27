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

Supported values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Validation happens after the child model resolves: non-`off` levels fail for non-reasoning models, and `xhigh` fails for models that do not advertise `xhigh` support. Omit the field to preserve the child's normal default/settings behavior. The child's actual effective level is reported in its `agent_start` event, result metadata, and `background_agent_end` event.

## Evidence-based Routing Guide

The built-in `/skill:model-routing-guide` workflow researches an explicitly scoped candidate set from `enabledModels` or skill arguments. It combines canonical provider/model documentation and public evidence with sanitized aggregate observations from local subagent session logs, then writes and validates `~/.dreb/agent/model-routing-guide.md`.

The guide is intended to improve role and cost fit, especially keeping planning/implementation work out of `Explore` and reserving expensive frontier models for work that actually needs them. It does not change the model resolution order above. See [skills.md](skills.md#model-routing-guide).

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
