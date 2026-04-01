---
name: mach6-plan
description: "Explore codebase, create implementation plan, create feature branch with dummy commit, open draft PR, post plan as PR comment. Everything lives on the PR from this point forward. Usage: mach6-plan 42"
argument-hint: "<issue-number>"
---

# mach6-plan — Plan, Branch, and Open PR

**User input:** $ARGUMENTS

This command is strictly for **planning**. Do NOT implement any code changes — no file edits, no file writes.

## Global Rules

1. **GitHub as shared memory** — Plans, reviews, assessments, and progress are posted as PR/issue comments so any future session can pick up context.
2. **HTML markers** — Use `<!-- mach6-plan -->` as the first line of plan comment bodies for reliable discovery.
3. **No `#N` in comment bodies** — GitHub auto-links `#N` to issues/PRs. Use "finding 3", "item 3", "stage 2" etc. instead.
4. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
5. **Co-authored-by** — Include `Co-Authored-By: Claude <noreply@anthropic.com>` in commit messages.
6. **Task tracking** — Use the `tasks_update` tool to show progress through multi-step commands.
7. **Project conventions** — Check for CLAUDE.md, AGENTS.md, .dreb/CONTEXT.md, and CONTRIBUTING.md before planning.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "read", title: "Read issue and context", status: "in_progress" },
  { id: "explore", title: "Explore codebase", status: "pending" },
  { id: "plan", title: "Draft implementation plan", status: "pending" },
  { id: "branch", title: "Create branch and draft PR", status: "pending" },
  { id: "post", title: "Post plan to PR", status: "pending" }
])
```

## Step 2: Read the issue

```bash
gh issue view <number>
gh issue view <number> --comments
```

Parse everything: problem statement, constraints, requirements, acceptance criteria, prior discussion, any existing assessment comments (look for `<!-- mach6-assessment -->`).

Update task: read → completed, explore → in_progress.

## Step 3: Read project conventions

Check for and read (first found):
- CONTRIBUTING.md, DEVELOPMENT.md, .github/CONTRIBUTING.md
- CLAUDE.md, AGENTS.md, .dreb/CONTEXT.md

Extract planning-relevant guidance: project layers, testing expectations, coding conventions.

## Step 4: Explore the codebase

Launch 2-3 Explore subagents in parallel. Agent definitions specify their own model with a provider fallback list — defaults work across providers and are fine for most cases. Override only with good reason (e.g. a particularly large or complex codebase warrants a stronger tier).
- **Similar features**: Find existing code that solves related problems, trace implementation patterns
- **Architecture**: Map relevant architecture layers, abstractions, data flow
- **Integration points**: Identify where new code connects to existing systems

Include project conventions in each agent's context. Each agent returns 5-10 key files. Read all identified files.

Update task: explore → completed, plan → in_progress.

## Step 5: Draft the plan

Create an implementation plan with:
- Clear analysis of the problem
- **Deliverables**: What will be produced (be specific)
- **Acceptance criteria**: How to verify the work is done
- **Files to create or modify**: List each with what changes
- **Testing approach**: What tests to write, what to verify
- **Risks and open questions**: Anything that might derail implementation

The plan should be **high-level on implementation details** (avoid cascading spec errors from over-specifying) but **specific on deliverables and acceptance criteria**.

**Project-layer coverage:** Cross-check the plan against discovered project layers. Every affected layer should be addressed.

**Test coverage planning:** If the project has tests, each behavior change must specify what tests to add or modify.

Present the plan to the user. Discuss and revise if they have feedback.

Update task: plan → completed, branch → in_progress.

## Step 6: Create branch and draft PR

```bash
# Derive branch name from issue
# Format: feature/issue-<N>-<slug> (slug = 3-5 words from title, lowercase, hyphens)
git checkout -b feature/issue-<N>-<slug>

# Create an empty commit so the PR can be opened
git commit --allow-empty -m "chore: open PR for issue <N>

Co-Authored-By: Claude <noreply@anthropic.com>"

git push -u origin feature/issue-<N>-<slug>

# Open draft PR
gh pr create --draft --title "<title>" --body "Closes #<N>

<brief description>

Implementation plan posted as a comment below."
```

Update task: branch → completed, post → in_progress.

## Step 7: Post plan to PR

```bash
gh pr comment <pr-number> --body "<!-- mach6-plan -->
## Implementation Plan

<full plan content>

---
*Plan created by mach6*"
```

Update task: post → completed.

Suggest next step: implement the plan, then `/skill:mach6-push` when ready.
