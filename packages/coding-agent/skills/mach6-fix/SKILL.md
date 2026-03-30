---
name: mach6-fix
description: "Fix review findings or CI failures on a PR. Reads review/assessment comments via HTML markers, implements fixes with batch sizing heuristics. Usage: mach6-fix 42 [finding-numbers] or mach6-fix 42 ci"
argument-hint: "<pr-number> [finding-numbers | ci]"
---

# mach6-fix — Fix Review Findings or CI Failures

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — Reviews and assessments are on the PR as comments with HTML markers.
2. **No `#N` in comment bodies** — Use "finding 3", "item 3" etc. instead.
3. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
4. **Co-authored-by** — Include `Co-Authored-By: Claude <noreply@anthropic.com>` in commit messages.
5. **Task tracking** — Use the `tasks_update` tool to show progress.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "gather", title: "Gather findings to fix", status: "in_progress" },
  { id: "fix", title: "Implement fixes", status: "pending" },
  { id: "verify", title: "Verify fixes", status: "pending" }
])
```

## Step 2: Parse input

Extract:
- **PR number** (required)
- **Finding numbers** to fix (optional — e.g., `1,2,3`)
- **`ci`** flag (optional — fix CI failures instead of review findings)

## Step 3: Checkout and gather context

```bash
gh pr checkout <pr-number>
git pull
```

### If `ci` was specified:

```bash
# Find the failed run
gh pr checks <pr-number>
gh run view <run-id> --log-failed
```

Read the failed CI logs and identify the issues to fix. Extract:
- Test names and assertion failures
- Stack traces
- Error messages and exit codes
- The last ~100 lines of each failed step

If all checks are passing, report this and stop.

### If finding numbers were specified:

Read the review and assessment comments from the PR:
```bash
gh pr view <pr-number> --json comments --jq '.comments[] | select(.body | contains("<!-- mach6-review -->")) | .body'
gh pr view <pr-number> --json comments --jq '.comments[] | select(.body | contains("<!-- mach6-assessment -->")) | .body'
```

Extract the specific findings to fix.

### If no finding numbers and not `ci`:

Read all review/assessment comments, present the findings classified as genuine, and ask the user which ones to fix.

Update task: gather → completed, fix → in_progress.

## Step 4: Batch sizing

Apply these heuristics for how many findings to tackle at once:
- **Simple fixes** (typos, naming, imports): ~10 per batch
- **Moderate fixes** (logic changes, refactors): ~6 per batch
- **Complex fixes** (architecture, new features): ~3 per batch

If there are more findings than the batch size, fix the first batch and let the user know to run `mach6-fix` again for the rest.

## Step 5: Implement fixes

For each finding:
1. Read the relevant code
2. Understand the issue fully
3. Implement the fix
4. Update task tracking to show which finding you're working on

If a fix is out of scope or would require significant refactoring, recommend deferring it to a new issue rather than fixing inline.

## Step 6: Verify

- Run the project's test suite if one exists
- Run any linting/formatting tools
- Verify each fix addresses the specific finding

Update task: fix → completed, verify → in_progress, then verify → completed.

Suggest next step: `mach6-push` then `mach6-review <pr-number>` for re-review.
