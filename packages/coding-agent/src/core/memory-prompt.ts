import type { MemoryIndexes } from "./resource-loader.js";

export interface MemoryInstructionsOptions {
	memoryIndexes: MemoryIndexes;
}

/**
 * Returns system prompt text that teaches the agent how to use the persistent memory system.
 * This covers memory types, file format, save/read conventions, and scoping rules.
 */
export function getMemoryInstructions(options: MemoryInstructionsOptions): string {
	const { globalMemoryDir, projectMemoryDir } = options.memoryIndexes;

	return `# Memory System

You have a persistent, file-based memory system. Memory survives across sessions and helps you recall user preferences, past decisions, project context, and useful references.

## Memory Directories

- **Global memory**: \`${globalMemoryDir}/\` — loaded in every session regardless of project
- **Project memory**: \`${projectMemoryDir}/\` — loaded only when working in this project

## Memory Entry Format

Each memory is a markdown file with YAML frontmatter:

\`\`\`markdown
---
name: descriptive-name
description: One-line description used for relevance matching
type: user-preferences | good-practices | project | navigation
---

Content of the memory entry.
\`\`\`

## Memory Types

### user-preferences
Who the user is: their role, goals, expertise, and how they prefer to work. These help you tailor your behavior. Save when you learn details about the user's background, preferences, or knowledge level.

### good-practices
Guidance the user has given about how to approach work — both corrections ("don't do X") and confirmations ("yes, keep doing that"). Structure as: the rule, then **Why:** (the reason) and **How to apply:** (when this kicks in). Record from both failure AND success.

### project
Ongoing work context: goals, decisions, deadlines, who is doing what. Convert relative dates to absolute dates when saving. Structure as: the fact, then **Why:** and **How to apply:**. These decay fast — the "why" helps judge whether the memory is still relevant.

### navigation
Pointers to where information lives in external systems: dashboards, issue trackers, Slack channels, documentation URLs. Save when you learn about resources outside the project directory.

## How to Save Memory

Two-step process using standard Read/Write/Edit tools:

1. **Write the memory file** (e.g., \`${globalMemoryDir}/user_role.md\` or \`${projectMemoryDir}/project_auth_rewrite.md\`)
2. **Add a pointer line to MEMORY.md** in the same directory. MEMORY.md is an index — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`

If the memory directory or MEMORY.md doesn't exist yet, create them.

## When to Save

- **user-preferences**: When you learn about the user's role, expertise, or working style
- **good-practices**: When the user corrects your approach OR confirms a non-obvious approach worked
- **project**: When you learn who is doing what, why, or by when
- **navigation**: When you learn about external resources and their purpose

If the user explicitly asks you to remember something, save it immediately. If they ask you to forget something, find and remove the relevant entry.

## When to Access Memory

- When the memory index suggests relevant entries exist for the current topic
- When the user explicitly asks you to recall or check something
- When starting work that might benefit from past context

Read individual memory files on-demand using the Read tool — only the MEMORY.md indexes are loaded at session start.

## What NOT to Save

- Code patterns, architecture, file paths — derivable from reading the codebase
- Git history — use \`git log\` / \`git blame\`
- Debugging solutions — the fix is in the code, the commit message has context
- Anything already in CLAUDE.md / AGENTS.md / CONTEXT.md
- Ephemeral task details only relevant to the current session

## Scoping Rules

- **Global memory** applies to all projects — save user preferences and cross-project practices here
- **Project memory** is specific to the current project — save project decisions and context here
- **Project identity** is determined by git repo root. All worktrees of the same repo share one memory directory. Outside a git repo, the working directory is the project root.

## Memory Maintenance

- Check for existing memories before creating duplicates — update instead
- Remove or update memories that become outdated
- Keep MEMORY.md under 200 lines (only the first 200 lines are loaded at session start)
- Organize semantically by topic, not chronologically

## Staleness Warning

Memory records can become stale. Before acting on a memory that names a specific file, function, or flag, verify it still exists. If a recalled memory conflicts with what you observe now, trust current state and update the memory.`;
}
