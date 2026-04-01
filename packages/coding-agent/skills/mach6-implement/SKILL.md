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
4. **Co-authored-by** — Include `Co-Authored-By: Claude <noreply@anthropic.com>` in commit messages.
5. **Task tracking** — Use the `tasks_update` tool to show progress.

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

Work through each deliverable in the plan:
1. Implement the changes described
2. Follow existing project patterns and conventions
3. Update task tracking as you complete each deliverable

For large plans, implement features in dependency order — later features may depend on earlier ones.

### Step 7i: Add tests

If the project has tests, add or update tests for each behavior change as specified in the plan.

### Step 8i: Verify

- Run the project's test suite
- Run any linting/formatting tools
- Build the project if applicable
- Verify each deliverable from the plan is addressed

Suggest next step: `/skill:mach6-push` then `/skill:mach6-review <pr-number>` for review.

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

For each finding:
1. Read the relevant code
2. Understand the issue fully
3. Implement the fix
4. Update task tracking per finding

Defer out-of-scope items to new issues.

### Step 7f: Verify

- Run tests and linting
- Verify each fix addresses its finding

Suggest next step: `/skill:mach6-push` then `/skill:mach6-review <pr-number>` for re-review.
