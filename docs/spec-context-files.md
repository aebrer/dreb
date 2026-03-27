# Spec: Context File Loading (CLAUDE.md + AGENTS.md)

## Overview

Dreb loads project context from markdown files at session start. To maximize compatibility with existing projects, dreb reads **both** `CLAUDE.md` (Claude Code convention) and `AGENTS.md` (pi-mono convention), plus its own `.dreb/` directory for dreb-specific configuration.

## File discovery

At session start, dreb walks the directory tree from the current working directory upward and collects context files:

```
Pseudocode:

function discover_context_files(cwd):
    files = []

    # 1. Walk upward from cwd to filesystem root
    dir = cwd
    while dir != parent(dir):
        # Check for context files at each level (all optional)
        for name in ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".dreb/CONTEXT.md"]:
            path = join(dir, name)
            if exists(path):
                files.append(path)
        dir = parent(dir)

    # 2. User-level context (global, applies to all projects)
    for path in ["~/.dreb/CONTEXT.md", "~/.claude/CLAUDE.md"]:
        if exists(expand(path)):
            files.append(expand(path))

    # 3. Rules directories (project-scoped)
    rules_dir = join(find_project_root(cwd), ".dreb/rules")
    if is_directory(rules_dir):
        for file in glob(rules_dir, "**/*.md"):
            frontmatter = parse_frontmatter(file)
            if frontmatter.get("paths"):
                # Path-scoped: defer until agent accesses matching files
                register_deferred_rule(file, frontmatter.paths)
            else:
                # Unconditional: load now
                files.append(file)

    # Also check .claude/rules/ for Claude Code compatibility
    claude_rules_dir = join(find_project_root(cwd), ".claude/rules")
    if is_directory(claude_rules_dir):
        for file in glob(claude_rules_dir, "**/*.md"):
            frontmatter = parse_frontmatter(file)
            if frontmatter.get("paths"):
                register_deferred_rule(file, frontmatter.paths)
            else:
                files.append(file)

    return deduplicate(files)  # same file via different paths = load once
```

## Load order and precedence

Files are loaded in this order (later content takes precedence for conflicting instructions):

1. User-level context (`~/.dreb/CONTEXT.md`, `~/.claude/CLAUDE.md`)
2. Project context walking upward (root-level first, then subdirectories)
3. Rules directory files (unconditional ones)
4. Memory index (see [spec-memory.md](spec-memory.md))
5. Skill descriptions (see [spec-skills.md](spec-skills.md))

All loaded content is concatenated and injected as a system reminder before the conversation begins.

## Injection format

```
Pseudocode:

function inject_context(session, files):
    sections = []

    for file in files:
        content = read_file(file)
        content = strip_html_comments(content)  # remove <!-- ... --> blocks

        # Label each section with its source
        relative = relative_path(file, session.cwd)
        sections.append(f"Contents of {relative}:\n\n{content}")

    combined = "\n\n---\n\n".join(sections)
    session.inject_system_reminder(combined)
```

## File format

Context files are plain markdown. No special syntax required beyond optional YAML frontmatter for rules files:

### CLAUDE.md / AGENTS.md (project root)
```markdown
# Project Name

Instructions for the AI agent working on this project.

## Build
- Run tests with: `npm test`
- Build with: `npm run build`

## Conventions
- Use TypeScript strict mode
- Prefer functional patterns over classes
```

### Rules with path scoping (.dreb/rules/ or .claude/rules/)
```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/handlers/**/*.ts"
---

# API Code Rules

- All endpoints must validate input with zod schemas
- Return proper HTTP status codes
- Log errors with structured logger
```

Path-scoped rules are re-injected as system reminders each time the agent reads a file matching the path patterns. This keeps specialized rules in context only when relevant.

## Compatibility matrix

| File | Claude Code | Pi-mono | Dreb |
|------|-------------|---------|------|
| `CLAUDE.md` | Yes | No | **Yes** |
| `.claude/CLAUDE.md` | Yes | No | **Yes** |
| `.claude/rules/*.md` | Yes | No | **Yes** |
| `AGENTS.md` | No | Yes | **Yes** |
| `.dreb/SYSTEM.md` | No | Yes | **Yes** (read, don't write) |
| `.dreb/CONTEXT.md` | No | No | **Yes** |
| `.dreb/rules/*.md` | No | No | **Yes** |
| `~/.claude/CLAUDE.md` | Yes | No | **Yes** |
| `~/.dreb/CONTEXT.md` | No | No | **Yes** |

The goal: any project that works with Claude Code or pi-mono works with dreb out of the box. Dreb reads all conventions, writes only to its own (`.dreb/`).

## Subdirectory context (lazy loading)

Context files in subdirectories below cwd are NOT loaded at startup. They load on-demand when the agent reads files in those directories:

```
project/
├── CLAUDE.md                    # Loaded at startup
├── packages/
│   ├── api/
│   │   └── CLAUDE.md            # Loaded when agent reads files in packages/api/
│   └── web/
│       └── CLAUDE.md            # Loaded when agent reads files in packages/web/
```

This keeps startup context lean for monorepos.

## Import syntax (future consideration)

Claude Code supports `@path/to/file` imports in CLAUDE.md to pull in external content. We may want to support this eventually, but it's not required for initial implementation. If implemented:

- `@relative/path.md` — include content of file relative to the context file's directory
- Max import depth: 5 (prevent circular includes)
- Imported content replaces the `@` line inline
