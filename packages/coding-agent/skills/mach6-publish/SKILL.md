---
name: mach6-publish
description: "Pre-merge checks, merge PR, version bump, git tag, GitHub release with notes, changelog update. Verifies CI, conflicts, and review status before merging. Usage: mach6-publish 42"
argument-hint: "<pr-number>"
---

# mach6-publish — Merge, Tag, and Release

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — All context lives on the PR.
2. **No `#N` in comment bodies** — Use "finding 3", "item 3" etc. instead.
3. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
4. **Co-authored-by** — Include `Co-Authored-By: Claude <noreply@anthropic.com>` in commit messages.
5. **Task tracking** — Use the `tasks_update` tool to show progress.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "checks", title: "Pre-merge checks", status: "in_progress" },
  { id: "prepare", title: "Apply pre-merge updates", status: "pending" },
  { id: "merge", title: "Merge PR", status: "pending" },
  { id: "release", title: "Tag and release", status: "pending" }
])
```

## Step 2: Pre-merge checks

```bash
gh pr view <pr-number> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,comments,body
gh pr checks <pr-number>
```

Read ALL PR comments to understand the full history — plans, reviews, assessments, progress updates, and discussion.

Verify:
- [ ] CI is passing
- [ ] No merge conflicts
- [ ] All review findings addressed (check for genuine items in latest assessment)

If there are blocking issues, report them and suggest fixes:
- **Failed CI**: `/skill:mach6-implement <pr-number> ci`
- **Merge conflicts**: Suggest resolving manually or rebasing
- **Unaddressed findings**: `/skill:mach6-implement <pr-number>`

### Pre-merge checklist

Check for contributing guidelines first:
```bash
# Read first found: CONTRIBUTING.md, DEVELOPMENT.md, .github/CONTRIBUTING.md
```

Then check if these need attention:
- [ ] Documentation updated (if behavior changed) — check README, docs/, docstrings, help text
- [ ] Version bumped (if project uses versioning — check package.json, Cargo.toml, pyproject.toml, etc.)
- [ ] Changelog updated (if project maintains one — check CHANGELOG.md, CHANGES.md)
- [ ] Tests passing locally

Present the checklist to the user. If items need attention, note them.

Update task: checks → completed, prepare → in_progress.

## Step 3: Apply pre-merge updates

If the checklist identified needed updates (version bump, changelog entry, docs, etc.):
1. Make the changes
2. Commit and push

```bash
git add <specific-files>
git commit -m "chore: pre-merge updates for PR <number>

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

For version bumps, if the bump level isn't obvious, ask the user:
- **Patch**: Bug fixes, minor improvements
- **Minor**: New features, non-breaking changes
- **Major**: Breaking changes

If no updates needed, skip this step.

Update task: prepare → completed, merge → in_progress.

## Step 4: Merge

```bash
gh pr merge <pr-number> --squash --delete-branch
```

Use `--squash` by default. If the user prefers a different merge strategy, they can specify.

Then update local:
```bash
git checkout $(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
git pull
```

Clean up local feature branch if it still exists:
```bash
git branch -d <branch-name> 2>/dev/null
```

Update task: merge → completed, release → in_progress.

## Step 5: Release (optional)

Ask the user if they want to create a release:
- **Yes**: Proceed with tagging and release
- **No**: Skip to cleanup

If yes:

1. Check existing releases for style:
   ```bash
   gh release list --limit 5
   gh release view <latest-tag>  # if releases exist
   ```

2. Determine the version (from package.json, latest tag, or ask the user)

3. Create a git tag:
   ```bash
   git tag v<version>
   git push --tags
   ```

4. Draft release notes from the PR description and comment thread. Match existing release note style.

5. Present draft to user for approval, then create:
   ```bash
   gh release create v<version> --title "v<version>" --notes "<release-notes>"
   ```

Update task: release → completed.

## Step 6: Report

Report: what was merged, tagged, released. Link to the PR and release.
