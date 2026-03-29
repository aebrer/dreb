# Spec: Skills System

## Overview

Skills are reusable prompt-driven workflows that the agent can invoke (or the user can trigger via slash command). A skill is a markdown file defining what the agent should do, with optional metadata controlling when and how it runs.

## Discovery

Skills are discovered from the filesystem at session start:

```
~/.dreb/agent/skills/<skill-name>/SKILL.md     # User-level (available everywhere)
.dreb/skills/<skill-name>/SKILL.md       # Project-level (repo-specific)
```

Symlinks are followed transparently — a skill can live in a project repo and be symlinked to `~/.dreb/agent/skills/` for global availability.

Nested plugin skills use namespaced names: `plugin-name:skill-name`.

## SKILL.md format

```markdown
---
name: review-pr
description: Comprehensive PR review using specialized agents. Use when the
             user asks to review a PR or wants code review before merging.
argument-hint: "[PR number or URL]"
disable-model-invocation: false               # (optional) prevent auto-invocation by agent
user-invocable: true                          # (optional) show in /slash menu
---

## Instructions

You are reviewing a pull request. Follow these steps:

1. Get the PR diff: `git diff main...HEAD`
2. Read all changed files in full
3. Check for: bugs, security issues, style violations, missing tests
4. Report findings organized by severity

## Arguments

$ARGUMENTS contains the PR identifier provided by the user.
If no arguments, review the current branch against main.
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Skill identifier, used for `/skill:name` invocation |
| `description` | yes | When to use this skill. Agent reads this to decide on auto-invocation. |
| `argument-hint` | no | Shown in `/` menu to hint at expected arguments |
| `tools` | no | Comma-separated tools to allow without permission prompts. **Not implemented** — dreb auto-allows all tools, so permission gating is unnecessary. |
| `model` | no | Override the session model for this skill. **Not implemented** — skills are prompt-driven; model selection is a session concern. |
| `context` | no | `"fork"` to run in an isolated subagent session. **Not implemented** — skills that want subagent delegation can instruct the agent directly in their body. |
| `agent` | no | Agent type if `context=fork`. **Not implemented** — see `context`. |
| `disable-model-invocation` | no | `true` = only user can invoke via `/`, agent cannot auto-invoke |
| `user-invocable` | no | `false` = hidden from `/` menu, only agent can invoke |

### Content substitution

Before injecting skill content into the session, perform these substitutions:

| Placeholder | Replaced with |
|-------------|---------------|
| `$ARGUMENTS` | Everything after the skill name in the invocation |
| `$0` | Alias for `$1` (first argument) |
| `$1`, `$2`, ... | Positional arguments (1-indexed, bash-style parsing) |
| `${DREB_SESSION_ID}` | Current session ID |
| `${DREB_SKILL_DIR}` | Absolute path to the skill's directory |

## Context loading strategy

**Descriptions are always in context.** At session start, all discovered skill descriptions are compiled into a compact list injected as a system reminder:

```
Available skills:
- review-pr: Comprehensive PR review using specialized agents
- telegram-send: Send files to the user via Telegram
- epub-search: Search within EPUB files from the Calibre library
...
```

This lets the agent know what skills exist and when to invoke them, without loading the full skill content.

**Full content loads on invocation only.** When a skill is invoked (by user or agent), the full SKILL.md content (with substitutions applied) is injected into the conversation.

```
Pseudocode:

function load_skill_descriptions():
    skills = discover_skills()  # scan ~/.dreb/agent/skills/ and .dreb/skills/

    descriptions = []
    for skill in skills:
        frontmatter = parse_frontmatter(skill.path)
        descriptions.append(f"- {frontmatter.name}: {frontmatter.description}")

    return "\n".join(descriptions)


function invoke_skill(skill_name, arguments):
    skill = find_skill(skill_name)
    if not skill:
        return error(f"Unknown skill: {skill_name}")

    # Read full content
    content = read_file(skill.path)
    frontmatter, body = parse_frontmatter_and_body(content)

    # Apply substitutions
    body = body.replace("$ARGUMENTS", arguments)
    body = body.replace("$0", arguments.split()[0] if arguments else "")
    # ... etc for $1, $2, env vars

    # NOTE: context=fork path is not implemented.
    # Skills that want subagent delegation instruct the agent in their body.

    # Inject into current session
    session.inject_user_message(body)
```

## Skill tool definition

```
Name: skill
Description: Invoke a skill by name with optional arguments.

Parameters:
  skill:  string (required)  # Skill name (e.g. "review-pr", "plugin:skill-name")
  args:   string (optional)  # Arguments to pass to the skill
```

## Relationship to pi-mono's extension system

Pi-mono has slash commands (registered via extensions) and "skills" (npm packages). Our skills system is simpler:

- **No npm packaging** — skills are local markdown files
- **No TypeScript** — skill logic is prompt-driven, not code-driven
- **Slash commands map to skills** — `/skill:review-pr` invokes the `review-pr` skill
- **Extensions are for tools** — custom tools are TypeScript extensions; skills are prompt workflows

A skill can reference extension tools (by listing them in the `tools` frontmatter), but the skill itself is always a prompt template, not executable code.

## Supporting files

A skill directory can contain additional files beyond SKILL.md:

```
~/.dreb/agent/skills/review-pr/
├── SKILL.md           # Main skill definition
├── examples.md        # Examples the agent can Read on-demand
├── checklist.md       # Review checklist template
└── scripts/
    └── get_diff.sh    # Helper script the skill can invoke via Bash
```

Supporting files are NOT loaded automatically. The skill's prompt can instruct the agent to read them as needed using `${DREB_SKILL_DIR}` to reference the directory.
