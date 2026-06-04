# Mach6 Model Settings

Configure per-agent model overrides for mach6 skill agents via settings.

## What it does

The `agentModels.models` setting lets you override the default model used by each subagent type (e.g., Explore, Sandbox) without modifying the agent definition files. You can specify an ordered fallback list — the first available model is used.

## Configuration

Add to your `~/.dreb/settings.json`:

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

Each key is an agent type name, and the value is an ordered list of model IDs (in `provider/model` format).

## Resolution Order

When a subagent is launched, models are resolved in this priority:

1. **Per-invocation `model` override** — highest priority, set explicitly in the subagent tool call
2. **`agentModels.models` setting** — from your settings.json, per agent type
3. **Agent definition `model` field** — from the `.md` agent file's frontmatter

If the mach6 models list is empty or undefined for a given agent, it falls through to the agent definition's model.

## TUI Usage

Open `/settings` and scroll to the ⚡ items. Each discovered agent type gets its own entry where you can:

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
