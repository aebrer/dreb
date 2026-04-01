> dreb can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

dreb implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Invocation](#invocation)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Content Substitution](#content-substitution)
- [Validation](#validation)
- [Example](#example)
- [Built-in Skills](#built-in-skills)
- [Skill Repositories](#skill-repositories)

## Locations

> **Note:** Skills can instruct the model to run commands and may include executable code. Skim what you're loading, same as any other dependency.

dreb loads skills from:

- Global:
  - `~/.dreb/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.dreb/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `dreb.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- Direct `.md` files in the skills directory root
- Recursive `SKILL.md` files under subdirectories

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.dreb/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, dreb scans skill locations and extracts names and descriptions
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses the `skill` tool to load the full SKILL.md with content substitution applied
4. Users can also invoke skills directly via `/skill:name [args]` slash commands
5. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

## Invocation

### Skill Tool (model-invocable)

The agent can invoke skills programmatically via the built-in `skill` tool:

```
skill(skill: "review-pr", args: "123")
```

The tool reads the SKILL.md, strips frontmatter, applies [content substitution](#content-substitution), and returns the expanded content. Skills with `disable-model-invocation: true` are hidden from the system prompt and return a warning if the model tries to invoke them.

### Slash Commands (user-invocable)

Skills register as `/skill:name` commands in interactive mode:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are passed through [content substitution](#content-substitution) into the skill content.

Skills with `user-invocable: false` are hidden from the `/` menu but remain available to the model via the skill tool.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
argument-hint: "<input file>"
---

# My Skill

## Setup

Run once before first use:
\`\`\`bash
cd ${DREB_SKILL_DIR} && npm install
\`\`\`

## Usage

Process the input file: $1

\`\`\`bash
${DREB_SKILL_DIR}/scripts/process.sh $1
\`\`\`
```

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required), plus dreb-specific fields:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `argument-hint` | No | Hint text shown in the `/` menu (e.g. `"[PR number or URL]"`). |
| `user-invocable` | No | Default `true`. When `false`, skill is hidden from the `/` menu but remains available to the model via the skill tool. |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Content Substitution

When a skill is invoked (via the skill tool or `/skill:name`), placeholders in the body are replaced before injection:

| Placeholder | Replaced with |
|-------------|---------------|
| `$ARGUMENTS`, `$@` | All arguments joined |
| `$0` | First argument (alias for `$1`) |
| `$1`, `$2`, ... | Positional arguments (bash-style parsing: supports quoting) |
| `${@:N}` | Arguments from the Nth position |
| `${@:N:L}` | `L` arguments starting at N |
| `${DREB_SKILL_DIR}` | Absolute path to the skill's directory |
| `${DREB_SESSION_ID}` | Current session ID |

Example:

```markdown
---
name: review-file
description: Review a specific file for issues.
argument-hint: "<filename>"
---
Read ${DREB_SKILL_DIR}/checklist.md for the review criteria.

Review the file: $1
Focus areas: ${@:2}
```

Usage: `/skill:review-file src/main.ts "security" "performance"`

## Validation

dreb validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
```markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

\`\`\`bash
cd ${DREB_SKILL_DIR} && npm install
\`\`\`

## Search

\`\`\`bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
\`\`\`

## Extract Page Content

\`\`\`bash
./content.js https://example.com
\`\`\`
```

## Built-in Skills

dreb ships with **mach6**, a development workflow that orchestrates the full issue-to-merge lifecycle using GitHub as shared memory. Six skills cover each stage:

| Skill | What it does |
|---|---|
| `mach6-issue` | Assess an existing issue or create a new one |
| `mach6-plan` | Explore codebase, plan, create branch and draft PR |
| `mach6-push` | Commit, push, post progress comment |
| `mach6-review` | Multi-agent code review with independent assessment |
| `mach6-implement` | Implement plans, fix review findings, or fix CI failures |
| `mach6-publish` | Pre-merge checks, merge, tag, release |

Built-in skills are always available and can be overridden by placing a skill with the same name in any [user or project location](#locations).

See [docs/mach6.md](mach6.md) for full documentation.

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription (from [pi-mono](https://github.com/badlogic/pi-mono), dreb's upstream fork)
