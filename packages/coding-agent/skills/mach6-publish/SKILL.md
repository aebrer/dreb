---
name: mach6-publish
description: "Pre-merge checks, version bump, merge PR, git tag, GitHub release. Version bump happens BEFORE merge (on the feature branch) because master requires PRs. Usage: mach6-publish 42"
argument-hint: "<pr-number>"
---

# mach6-publish — Version Bump, Merge, Tag, and Release

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — All context lives on the PR.
2. **No `#N` in comment bodies** — Use "finding 3", "item 3" etc. instead.
3. **Safe git** — Never use `git add -A` or `git add .`. Stage files by name. Never stage secrets.
4. **Task tracking** — Use the `tasks_update` tool to show progress.
5. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks.

## Step 1: Set up task tracking

```
tasks_update([
  { id: "checks", title: "Pre-merge checks", status: "in_progress" },
  { id: "version", title: "Version bump (on feature branch)", status: "pending" },
  { id: "docs", title: "Update documentation", status: "pending" },
  { id: "merge", title: "Merge PR", status: "pending" },
  { id: "release", title: "Tag and release", status: "pending" }
])
```

## Step 2: Pre-merge checks

```bash
gh pr checkout <pr-number>
git pull
gh pr view <pr-number> --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,comments,body
gh pr checks <pr-number>
```

**Note:** `gh pr checks` returns exit code 8 while checks are still pending — this is expected, not a failure. Wait and re-run if needed.

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
# Read first found: CONTRIBUTING.md, DEVELOPMENT.md, .github/CONTRIBUTING.md, AGENTS.md
```

Then check if these need attention:
- [ ] Documentation updated (if behavior changed) — check README, docs/, docstrings, help text
- [ ] Changelog updated (if project maintains one — check CHANGELOG.md, CHANGES.md)
- [ ] Tests passing locally

Present the checklist to the user. If items need attention, address them before proceeding.

Update task: checks → completed, version → in_progress.

## Step 3: Version bump (on the feature branch — BEFORE merge)

**This step is mandatory for projects with versioning.** The version bump MUST happen on the feature branch and be pushed as part of the PR, because the default branch requires PRs for all changes — you cannot push commits directly to it.

1. Detect versioning:
   ```bash
   # Check for version files: package.json, Cargo.toml, pyproject.toml, version.txt, etc.
   ```

2. Determine the current version and what the new version should be. If the bump level isn't obvious from the PR context, **ask the user**:
   - **Patch**: Bug fixes, minor improvements
   - **Minor**: New features, non-breaking changes
   - **Major**: Breaking changes

3. Apply the version bump. Check AGENTS.md / CONTRIBUTING.md for project-specific version bump procedures (e.g., sync scripts, build steps that embed the version).

4. Commit and push on the feature branch:
   ```bash
   git add <version-files>
   git commit -m "chore: bump version to <new-version>"
   git push
   ```

5. Wait for CI to pass on the version bump commit before proceeding to merge.

If the project doesn't use versioning, skip this step.

Update task: version → completed, docs → in_progress.

## Step 4: Update documentation

Proactively review and update ALL documentation affected by the PR's changes. This is not limited to mach6 docs — check everything in the repo.

1. Identify changed features by reading the PR diff:
   ```bash
   gh pr diff <pr-number>
   ```

2. Scan all documentation for references to changed features:
   - README.md files across all packages
   - docs/ directory (all .md files)
   - AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .dreb/CONTEXT.md
   - Example files and their READMEs
   - Help text and CLI flag documentation
   - CHANGELOG.md or CHANGES.md

3. For each doc, verify:
   - CLI flags, settings, and commands match current code
   - Code snippets and examples are accurate
   - Cross-references point to real files and valid anchors
   - No stale descriptions of removed or changed features
   - Environment variables listed match current code

4. Fix all inaccuracies found. Commit and push:
   ```bash
   git add <doc-files>
   git commit -m "docs: update documentation for <version>"
   git push
   ```

5. Wait for CI to pass on the docs commit.

If no documentation changes are needed (rare), skip this step.

Update task: docs → completed, merge → in_progress.

## Step 5: Merge

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

## Step 6: Tag and release

Ask the user if they want to create a GitHub release:
- **Yes**: Proceed with tagging and release
- **No**: Skip — just create the tag

### Always create the git tag

The tag is created on the default branch after merge, using the version from Step 3:

```bash
git tag v<version>
git push --tags
```

### If releasing

1. Check existing releases for style:
   ```bash
   gh release list --limit 5
   gh release view <latest-tag>  # if releases exist
   ```

2. Draft release notes from the PR description and comment thread. Match existing release note style.

3. Present draft to user for approval, then create:
   ```bash
   cat > /tmp/gh-release-notes.md << 'MACH6_EOF'
   <release-notes>
   MACH6_EOF
   gh release create v<version> --title "v<version>" --notes-file /tmp/gh-release-notes.md
   ```

Update task: release → completed.

## Step 7: Report

Report: what was merged, tagged, released. Link to the PR and release.
