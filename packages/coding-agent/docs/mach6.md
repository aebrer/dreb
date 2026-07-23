# mach6 — Development Workflow

mach6 is a built-in workflow that orchestrates the full issue-to-merge lifecycle using GitHub as shared memory. Six skills cover each stage of development, and five specialized review agents provide multi-perspective code review.

Inspired by [mach10](https://github.com/LeanAndMean/mach10) (MIT, by Kevin Ryan) with design insights from Anthropic's [harness design blog post](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Quick Start

```
/skill:mach6-issue 42          # Assess an issue
/skill:mach6-plan 42           # Plan, branch, open draft PR
# ... implement the plan ...
/skill:mach6-push              # Commit, push, post progress
/skill:mach6-review 53         # User explicitly starts review
/skill:mach6-implement 53 1,2   # Fix review findings
/skill:mach6-push              # Durably save fixes
/skill:mach6-review 53         # User explicitly starts re-review
/skill:mach6-publish 53        # Docs update, merge, tag, release
```

## Skills

### mach6-issue

Assess an existing GitHub issue or create a new one.

```
/skill:mach6-issue 42              # Assess issue 42
/skill:mach6-issue                 # Create a new issue (interactive)
/skill:mach6-issue add dark mode   # Create issue from description
```

**Assess mode:** Launches parallel subagents to explore the codebase, then posts a structured assessment (summary, gaps, ambiguities, scope, risks) as an issue comment.

**Create mode:** Drafts a structured issue with title, summary, acceptance criteria, and technical notes.

### mach6-plan

Explore the codebase, create an implementation plan, open a draft PR, and post the plan as a PR comment.

```
/skill:mach6-plan 42
```

- Reads the issue and any existing assessment
- Checks project conventions (AGENTS.md, CONTRIBUTING.md, etc.)
- Launches parallel subagents to explore similar features, architecture, and integration points
- Creates a feature branch (`feature/issue-42-<slug>`) with an empty commit
- Opens a draft PR linking to the issue
- Posts the plan as a PR comment with `<!-- mach6-plan -->` marker

The plan is intentionally high-level on implementation details but specific on deliverables and acceptance criteria.

### mach6-push

Commit changes, push to remote, and post a progress comment.

```
/skill:mach6-push                          # Auto-generate commit message
/skill:mach6-push fix auth token refresh   # Use provided message
```

- Stages files by name (never `git add -A`)
- Matches the repository's existing commit style
- Auto-detects the associated PR from the current branch
- Posts a `<!-- mach6-progress -->` comment with a summary of changes
- Establishes the durable accountability and recovery checkpoint before formal review
- Stops after pushing and suggests the review command; it never starts review itself

### mach6-review

Run specialized review agents in parallel, post findings, then independently assess each finding. Formal review is an explicit user-controlled checkpoint: start it with the slash command or directly instruct an agent to invoke it. Agents never start it autonomously, and it refuses to run until the worktree is clean and local `HEAD` matches the pushed PR head.

```
/skill:mach6-review 53                     # Full review (all agents)
/skill:mach6-review 53 code errors         # Only code-reviewer + error-auditor
/skill:mach6-review 53 tests              # Only test-reviewer
```

Produces two PR comments:

1. **Review** (`<!-- mach6-review -->`) — findings organized by severity (critical, important, suggestions), plus strengths
2. **Assessment** (`<!-- mach6-assessment -->`) — each finding independently classified as genuine issue, nitpick, false positive, or deferred, with a prioritized action plan containing genuine issues only

A finding is genuine only when it passes both a **factual gate** (the current code contains the problem) and a **scope gate** (the problem must be fixed to deliver the authorized work safely and correctly). Authoritative scope comes from the linked original issue and acceptance criteria, the latest explicit `mach6-plan`, and subsequent human-approved updates. Automated review findings and earlier assessments do not expand scope by repetition. Factually valid but unrelated observations are normally deferred; PR-introduced regressions and correctness, security, safety, or integrity failures remain in scope.

See [Review Agents](#review-agents) below.

### mach6-implement

Implement a plan from a PR, or fix review findings / CI failures.

```
/skill:mach6-implement 53             # Implement the plan on PR 53
/skill:mach6-implement 53 1,2,3       # Fix specific review findings
/skill:mach6-implement 53 ci          # Fix CI failures
```

In both modes, the parent model owns implementation reasoning: design, decomposition, exact changes, decision rules, tests, and verification. Direct parent implementation is generally acceptable. `feature-dev` delegation is optional and is best reserved for high-volume, repetitive, mechanically scoped execution after the parent has settled the design—for example, applying a content-dependent transformation across dozens of files. Every delegated task receives clear, detailed, specific instructions rather than an open-ended design problem.

**Implement mode** (PR number only): Reads the `<!-- mach6-plan -->` comment, decides the implementation, and either works directly or delegates precisely specified execution.

**Fix mode** (with finding numbers or `ci`): Reads review and assessment comments via HTML markers, verifies each authorized finding, decides the fix, and then implements directly or delegates mechanically settled execution.

After direct verification, `mach6-implement` stops at the accountability checkpoint and suggests `/skill:mach6-push`. Committing, pushing, and posting progress protects work from loss or repeated unsupervised rewriting. The user can subsequently start formal `mach6-review` with its slash command or by directly instructing an agent to invoke it; agents never start review autonomously. Focused one-off reviewer/checker subagents remain available for narrow correctness questions or second opinions; they are not a formal mach6 review cycle.

### mach6-publish

Pre-merge checks, version bump, docs update, merge, tag, and release.

```
/skill:mach6-publish 53
```

- Verifies CI passing, no merge conflicts, all findings addressed
- Runs pre-merge checklist (version bump, tests)
- Applies version bump on the feature branch
- Proactively reviews and updates ALL documentation affected by the PR's changes
- Merges with `--squash --delete-branch`
- Optionally creates a git tag and GitHub release

## Agents

### feature-dev

Strong general-purpose coding agent optionally used by `mach6-implement` for precisely specified execution. It has full tool access (read, write, edit, grep, find, ls, bash, search) and uses a strong-tier model with a provider fallback list. The parent model retains design ownership and may implement directly; `feature-dev` is most useful for high-volume, repetitive work with settled decision rules.

### Review Agents

Five specialized agents, each asking an orthogonal question. All use confidence scoring (only report findings ≥ 80).

| Agent | Question | When it runs |
|---|---|---|
| **code-reviewer** | Does this code do what it should, correctly and idiomatically? | Always |
| **error-auditor** | What can go wrong silently at runtime? | If error handling / try-catch / fallback logic touched |
| **test-reviewer** | What behaviors are untested or poorly tested? | If test files changed or testable code added |
| **completeness-checker** | Does this PR deliver everything the linked issue requires? | If PR links to an issue |
| **simplifier** | Can this be expressed more clearly without changing behavior? | Always (runs last) |

Agents run as [subagents](../README.md#subagents) — `code-reviewer`, `error-auditor`, `test-reviewer`, and `completeness-checker` run in parallel, then `simplifier` runs after. Each agent reads the actual changed files, not just the diff.

**Targeted review:** Pass aspect names to run only specific agents: `code`, `errors`, `tests`, `completeness`, `simplify`.

## Design Principles

- **GitHub as shared memory** — Plans, reviews, assessments, and progress are posted as PR/issue comments with HTML markers (`<!-- mach6-plan -->`, `<!-- mach6-review -->`, etc.) so any future session can pick up context.
- **Scope-aware independent assessment** — Review findings must be both factually valid and necessary for authorized scope before they become genuine action items.
- **Durable accountability checkpoint** — Implementation and fixes are committed, pushed, and recorded before formal review so work cannot be lost or repeatedly rewritten while still local.
- **User-controlled review cycles** — Only the user starts each formal review or re-review. Agents stop at the checkpoint and suggest the next command rather than autonomously chaining review and fix cycles.
- **Focused checks remain available** — One-off reviewer/checker subagents may answer narrow correctness questions without becoming a formal mach6 review cycle.
- **Parent-owned implementation** — The parent model owns design and may implement directly; delegation is optional execution support for mechanically settled grunt work.
- **Safe git** — Never `git add -A`, never stage secrets, stage files by name.
- **Overridable** — Both skills and review agents can be overridden by placing files with the same name in `~/.dreb/agent/skills/` or `~/.dreb/agents/` (user-level) or `.dreb/skills/` or `.dreb/agents/` (project-level).

> The models used by mach6 subagents (e.g. `feature-dev`, the review agents) can be configured via the `agentModels` setting without editing agent definition files. See [Agent Model Settings](agent-models.md).

## Requirements

mach6 uses the [GitHub CLI](https://cli.github.com/) (`gh`) for all GitHub operations. Make sure it's installed and authenticated:

```bash
gh auth status
```
