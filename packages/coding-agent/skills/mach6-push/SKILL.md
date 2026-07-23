---
name: mach6-push
description: "Commit changes, push to remote, and post a progress comment on the associated PR or issue. Stages files by name (never git add -A), matches existing commit style, auto-detects PR from branch. Usage: mach6-push [optional commit message]"
argument-hint: "[commit message]"
---

# mach6-push — Commit, Push, Progress Comment

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — Progress is posted as PR/issue comments so any future session can pick up context.
2. **HTML markers** — Use `<!-- mach6-progress -->` as the first line of progress comment bodies.
3. **No `#N` in comment bodies** — Use "finding 3", "item 3", "stage 2" etc. instead.
4. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets (.env, credentials, tokens, keys).
5. **Task tracking** — Use the `tasks_update` tool to show progress.
6. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks. Write each body to a **unique per-invocation temp file** via `mktemp` (e.g. `GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"`) — never a fixed path like `/tmp/gh-comment.md`, which concurrent mach6 sessions on the same machine would clobber, cross-posting one session's body to another's PR/issue.
7. **Stop after durable progress** — The commit, push, and GitHub progress comment are the accountability and recovery boundary. Do not invoke `mach6-review` or continue into a formal review cycle. Only the user may start formal review; offer it with `suggest_next` and stop.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "stage", title: "Stage changes", status: "in_progress" },
  { id: "commit", title: "Commit", status: "pending" },
  { id: "push", title: "Push to remote", status: "pending" },
  { id: "comment", title: "Post progress comment", status: "pending" }
])
```

## Step 2: Stage changes

Run `git status` and `git diff` to understand the current state.

- If you have context from this session about which files were modified, stage those by name.
- If files are already staged and look correct, proceed.
- If unclear (fresh session, no context), review all changes and ask the user what to stage.
- **Never** use `git add -A` or `git add .`
- **Never** stage secrets (.env, credentials, tokens, keys)

Update task: stage → completed, commit → in_progress.

## Step 3: Commit

Check recent commit style:
```bash
git log --oneline -10
```

Generate a commit message that:
- Follows the repository's existing style
- Summarizes the nature of the changes
- Uses the user's override message if provided

```bash
git commit -m "<message>"
```

Update task: commit → completed, push → in_progress.

## Step 4: Push

```bash
git push
```

If no upstream is set, use `git push -u origin <branch>`.

Update task: push → completed, comment → in_progress.

## Step 5: Post progress comment

Detect the associated PR or issue:

1. **Session context first**: If an earlier mach6 command in this session targeted a specific PR or issue, use that.
2. **PR detection**: Try `gh pr view --json number,url` on current branch. If a PR exists, comment on it.
3. **Branch name fallback**: Check branch name for issue number pattern (e.g., `feature/issue-55-*`). If found, comment on that issue.
4. **Skip gracefully**: If neither works, skip commenting and inform the user.

If session context points to an issue but a PR also exists on the current branch, prefer the PR.

Post a progress comment:
```bash
GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"
cat > "$GH_BODY" << 'MACH6_EOF'
<!-- mach6-progress -->
## Progress Update

<summary of changes in this batch>

**Commit:** \`<hash>\`

---
*Progress tracked by mach6*
MACH6_EOF
gh pr comment <number> --body-file "$GH_BODY"
```

Update task: comment → completed.

Report: what was committed, where pushed, and where the comment was posted (with link). The work is now durably saved and available for accountable review.

Stop here. Do not invoke `mach6-review`, launch formal review agents, or begin a review-fix-review loop. Only the user may start formal review.

Use `suggest_next` for exactly one context-appropriate command, then end the turn:
- If on a feature branch with a PR: `/skill:mach6-review <pr-number>`
- If on a feature branch without a PR: `/skill:mach6-plan <issue-number>` to create one
- If on the default branch: an issue-oriented next step
