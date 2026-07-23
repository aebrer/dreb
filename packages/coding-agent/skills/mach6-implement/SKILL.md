---
name: mach6-implement
description: "Implement a plan from a PR, or fix review findings / CI failures. Usage: mach6-implement 42 [finding-numbers] or mach6-implement 42 ci"
argument-hint: "<pr-number> [finding-numbers | ci]"
---

# mach6-implement — Implement Plans, Fix Findings, or Fix CI

**User input:** $ARGUMENTS

This skill has two modes:
- **Implement mode** (just a PR number): reads the plan comment and implements it
- **Fix mode** (with finding numbers or `ci`): fixes specific review findings or CI failures

## Global Rules

1. **GitHub as shared memory** — Plans, reviews, and assessments are on the PR as comments with HTML markers.
2. **No `#N` in comment bodies** — Use "finding 3", "item 3" etc. instead.
3. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
4. **Task tracking** — Use the `tasks_update` tool to show progress.
5. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks. Write each body to a **unique per-invocation temp file** via `mktemp` (e.g. `GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"`) — never a fixed path like `/tmp/gh-comment.md`, which concurrent mach6 sessions on the same machine would clobber, cross-posting one session's body to another's PR/issue.

## Parent ownership and the formal-review checkpoint

These rules apply in both implement and fix modes, even if you never load the `mach6-push` or `mach6-review` skills:

- **The parent model owns implementation reasoning.** You decide the design, decomposition, exact changes, constraints, and verification strategy. Do not use a subagent as a substitute for thinking through the implementation.
- **Direct implementation is generally acceptable.** The parent may implement any deliverable or fix directly; this is not limited to trivial work.
- **Delegate execution, not unresolved design.** `feature-dev` is optional and is most useful for high-volume, repetitive, mechanically scoped grunt work after you have settled the rules—for example, applying a content-dependent transformation across dozens of files. Ordinary reading and writing alone is not a reason to delegate.
- **Every delegated task must be clear, detailed, and specific.** Give the agent the intended changes, exact relevant files, existing patterns to follow, decision rules, constraints, required tests, and expected verification. Resolve ambiguity yourself before delegation; never hand off a vague deliverable and ask the agent to design it.
- **Focused checks remain allowed.** You may launch a focused, one-off reviewer or checker subagent for a narrow correctness question or second opinion. Do not turn that into the formal mach6 multi-agent review/assessment workflow or an autonomous review-fix-review loop.
- **Save work before formal review.** A successful implementation is not yet durable shared work. Committing, pushing, and posting a GitHub progress comment creates the accountability and recovery boundary, reducing the risk that unsupervised review cycles repeatedly rewrite or destroy work before it is saved.
- **Only the user starts formal `mach6-review`.** After implementation and direct verification, do not invoke `mach6-review` and do not begin a review cycle. Use `suggest_next` to offer `/skill:mach6-push`, then stop. After the push is complete, the user decides whether to explicitly invoke review.

## Step 1: Parse input

Extract:
- **PR number** (required)
- **Finding numbers** to fix (optional — e.g., `1,2,3`)
- **`ci`** flag (optional — fix CI failures instead of review findings)

If only a PR number is given → **implement mode**.
If finding numbers or `ci` → **fix mode**.

## Step 2: Checkout

```bash
gh pr checkout <pr-number>
git pull
```

---

## Implement Mode (PR number only)

### Step 3i: Read the plan and full PR context

Read ALL PR comments and the PR body to get complete context:
```bash
gh pr view <pr-number> --json title,body,comments
```

Find the plan comment (contains `<!-- mach6-plan -->` marker) from the comments. If no plan comment exists, tell the user and suggest running `/skill:mach6-plan` first.

Also read any progress updates, prior review findings, assessments, and discussion — all of this context informs implementation.

### Step 4i: Set up task tracking

Create tasks based on the plan's deliverables/features. Example:
```
tasks_update([
  { id: "read", title: "Read plan and codebase", status: "in_progress" },
  { id: "feature-1", title: "Implement feature 1", status: "pending" },
  { id: "feature-2", title: "Implement feature 2", status: "pending" },
  { id: "test", title: "Add/update tests", status: "pending" },
  { id: "verify", title: "Build and verify", status: "pending" }
])
```

### Step 5i: Read the codebase

Read all files mentioned in the plan. Understand the existing code before making changes.

### Step 6i: Implement

For each deliverable, first decide the implementation yourself: map it to the approved plan, inspect the relevant code, settle the design and decision rules, identify exact files and patterns, and define the required tests and verification.

Implement directly unless delegation has a concrete context-preservation benefit. Direct parent implementation is generally acceptable regardless of plan size. Use the pre-existing `feature-dev` agent only for execution that is sufficiently high-volume, repetitive, and mechanically specified to justify delegation; do not delegate merely because a task involves reading and writing code.

When delegating, provide a complete execution plan containing:
- The authorized deliverable and why it is in scope
- Exact files or a precisely bounded file set
- Specific changes and content-dependent decision rules
- Existing code patterns and constraints to preserve
- Required tests, linting, and validation commands
- Expected observable result and completion criteria
- Relevant plan and PR discussion context

A `feature-dev` agent should be able to execute without inventing design decisions. If direction is ambiguous, the parent must resolve it before delegation. Do not override the agent's model unless there is a specific reason.

**Test coverage is part of the deliverable, not an afterthought.** Implement all planned tests with the behavior they cover. If the target package lacks test infrastructure, add it.

**Parallelism:** Parallelize only independent, mechanically specified tasks that do not overlap files or depend on unresolved work. Otherwise implement directly or sequence the work.

Update task tracking as each deliverable completes.

### Step 7i: Verify

After all `feature-dev` agents complete:
- Run the project's test suite
- Run any linting/formatting tools
- Build the project if applicable
- Verify each deliverable from the plan is addressed
- If any agent reported issues or partial completion, address the gaps

Stop at the accountability checkpoint. Do **not** invoke `mach6-review` or begin a formal review cycle. Explain that the implementation must be committed, pushed, and recorded before the user decides whether to review. Use `suggest_next` to offer `/skill:mach6-push`, then end the turn.

---

## Fix Mode (finding numbers or `ci`)

### Step 3f: Set up task tracking

```
tasks_update([
  { id: "gather", title: "Gather findings to fix", status: "in_progress" },
  { id: "fix", title: "Implement fixes", status: "pending" },
  { id: "verify", title: "Verify fixes", status: "pending" }
])
```

### Step 4f: Gather context

#### If `ci` was specified:

```bash
gh pr checks <pr-number>
gh run view <run-id> --log-failed
```

**Note:** `gh pr checks` returns exit code 8 while checks are still pending — this is expected, not a failure. Wait and re-run if needed.

Read the failed CI logs and identify issues. Extract test failures, stack traces, error messages. If all checks pass, report this and stop.

#### If finding numbers were specified:

Read ALL PR comments to get full context:
```bash
gh pr view <pr-number> --json title,body,comments
```

Find the review (`<!-- mach6-review -->`) and assessment (`<!-- mach6-assessment -->`) comments, then extract the specific findings to fix. Prior progress comments and discussion may also provide useful context.

#### If no finding numbers and not `ci`:

Read ALL PR comments, find review/assessment comments, present genuine findings, and ask which to fix.

### Step 5f: Batch sizing

- **Simple fixes** (typos, naming, imports): ~10 per batch
- **Moderate fixes** (logic changes, refactors): ~6 per batch
- **Complex fixes** (architecture, new features): ~3 per batch

If more than batch size, fix first batch and tell user to re-run.

### Step 6f: Implement fixes

For each authorized finding, the parent must verify the assessment against the current code, decide the exact fix, identify affected files and patterns, and define the regression tests and validation before editing or delegating.

Implement fixes directly by default. Use the pre-existing `feature-dev` agent only when a fix has high-volume, repetitive, mechanically settled execution that benefits from context isolation. Direct parent implementation is acceptable for simple and complex fixes alike.

When delegating, provide:
- The finding and its factual and scope reasoning
- Exact files and code locations, or a precisely bounded file set
- The complete fix design and content-dependent decision rules
- Existing patterns and constraints to preserve
- Required regression tests and validation commands
- Expected result and completion criteria

Do not ask `feature-dev` to determine the design. Resolve ambiguity before delegation, and do not override its model unless there is a specific reason.

**Parallelism:** Parallelize only independent, mechanically specified fixes that do not overlap files. Otherwise implement directly or sequence them.

Defer only review-surfaced items that are factually valid but outside the authoritative PR scope. User-approved requirements are in scope. Update task tracking per finding.

### Step 7f: Verify

After all `feature-dev` agents complete:
- Run tests and linting
- Verify each fix addresses its finding
- If any agent reported issues, address the gaps

Stop at the accountability checkpoint. Do **not** invoke `mach6-review` or begin a formal re-review cycle. Explain that the fixes must be committed, pushed, and recorded before the user decides whether to re-review. Use `suggest_next` to offer `/skill:mach6-push`, then end the turn.
