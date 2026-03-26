# Spec: Memory System

## Overview

Persistent, file-based memory that survives across sessions. The agent can read and write memory entries that inform future conversations. Memory is structured by type (user preferences, feedback, project context, references) and scoped (global vs per-project).

## Storage layout

```
~/.dreb/memory/                     # Global memory (applies to all projects)
├── MEMORY.md                       # Index file — always loaded at session start
├── user_role.md                    # Individual memory entries
├── feedback_testing.md
└── ...

<project>/.dreb/memory/             # Project-scoped memory
├── MEMORY.md
├── project_auth_rewrite.md
└── ...
```

## Memory entry format

Each memory is a markdown file with YAML frontmatter:

```markdown
---
name: descriptive-name
description: One-line description used for relevance matching
type: user | feedback | project | reference
---

Content of the memory entry. For feedback and project types,
structure as: rule/fact, then **Why:** and **How to apply:** lines.
```

### Types

- **user** — who the user is, their role, preferences, expertise level
- **feedback** — corrections and confirmations about how to work ("don't do X", "keep doing Y")
- **project** — ongoing work context, goals, deadlines, decisions
- **reference** — pointers to external resources (URLs, systems, dashboards)

## MEMORY.md index

The index file is a lightweight pointer list — not memory content itself:

```markdown
# Memory

- [User role](user_role.md) — data scientist focused on observability
- [Testing feedback](feedback_testing.md) — integration tests, no mocks
- [Auth rewrite](project_auth_rewrite.md) — driven by compliance, not tech debt
```

**Loading rules:**
- First 200 lines of MEMORY.md are injected into context at session start
- Individual memory files are NOT loaded at startup — the agent reads them on-demand using the standard Read tool when a topic seems relevant
- This keeps startup context lean while making all memory accessible

## Context injection

At session start, the memory system injects content as a system reminder:

```
Pseudocode:

function inject_memory(session):
    # 1. Load global memory index
    global_index = read_file("~/.dreb/memory/MEMORY.md")
    if global_index:
        global_index = truncate_lines(global_index, 200)

    # 2. Load project memory index
    project_dir = find_project_root(session.cwd)
    project_index = read_file(f"{project_dir}/.dreb/memory/MEMORY.md")
    if project_index:
        project_index = truncate_lines(project_index, 200)

    # 3. Combine and inject
    memory_context = ""
    if global_index:
        memory_context += f"## Global Memory\n{global_index}\n\n"
    if project_index:
        memory_context += f"## Project Memory\n{project_index}\n\n"

    if memory_context:
        session.inject_system_reminder(
            f"Your memory index (read individual files for details):\n\n{memory_context}"
        )
```

## Writing memory

No special tool required. The agent writes memory using the standard Write/Edit tools, following the format convention. The system prompt instructs the agent on when and how to write memory entries.

The two-step process:
1. Write the memory file (e.g. `~/.dreb/memory/feedback_testing.md`)
2. Add a pointer line to `MEMORY.md`

This is convention-based, not tool-enforced. The system prompt defines the convention; the agent uses existing file tools to follow it.

## Scoping rules

- **Global memory** (`~/.dreb/memory/`): loaded in every session regardless of project
- **Project memory** (`<project>/.dreb/memory/`): loaded only when working in that project
- **Project identity**: determined by git repo root (all worktrees share one memory dir). Outside git repos, the working directory is the project root.

## What NOT to save

The system prompt should instruct the agent to avoid storing:
- Code patterns derivable from reading the codebase
- Git history (use `git log`)
- Debugging solutions (the fix is in the code)
- Anything already in CLAUDE.md / AGENTS.md
- Ephemeral task details only relevant to the current session

## Relationship to CLAUDE.md / AGENTS.md

Memory and context files serve different purposes:
- **CLAUDE.md / AGENTS.md**: human-written project instructions, always loaded in full, checked into the repo
- **Memory**: agent-written persistent notes, loaded as index only, NOT checked into the repo (lives in `~/.dreb/` or gitignored `.dreb/`)

Both are injected at session start, but memory is the agent's own recall system while context files are the user's standing instructions.
