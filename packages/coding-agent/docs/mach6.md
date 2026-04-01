# mach6 — Development Workflow

mach6 is a built-in workflow that orchestrates the full issue-to-merge lifecycle using GitHub as shared memory. Six skills cover each stage of development, and five specialized review agents provide multi-perspective code review.

Inspired by [mach10](https://github.com/LeanAndMean/mach10) (MIT, by Kevin Ryan) with design insights from Anthropic's [harness design blog post](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Quick Start

```
/skill:mach6-issue 42          # Assess an issue
/skill:mach6-plan 42           # Plan, branch, open draft PR
# ... implement the plan ...
/skill:mach6-push              # Commit, push, post progress
/skill:mach6-review 53         # Multi-agent code review
/skill:mach6-implement 53 1,2   # Fix review findings
/skill:mach6-push              # Push fixes
/skill:mach6-review 53         # Re-review (repeat until clean)
/skill:mach6-publish 53        # Merge, tag, release
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

### mach6-review

Run specialized review agents in parallel, post findings, then independently assess each finding.

```
/skill:mach6-review 53                     # Full review (all agents)
/skill:mach6-review 53 code errors         # Only code-reviewer + error-auditor
/skill:mach6-review 53 tests              # Only test-reviewer
```

Produces two PR comments:

1. **Review** (`<!-- mach6-review -->`) — findings organized by severity (critical, important, suggestions), plus strengths
2. **Assessment** (`<!-- mach6-assessment -->`) — each finding independently classified as genuine issue, nitpick, false positive, or deferred, with a prioritized action plan

See [Review Agents](#review-agents) below.

### mach6-implement

Implement a plan from a PR, or fix review findings / CI failures.

```
/skill:mach6-implement 53             # Implement the plan on PR 53
/skill:mach6-implement 53 1,2,3       # Fix specific review findings
/skill:mach6-implement 53 ci          # Fix CI failures
```

**Implement mode** (PR number only): Reads the `<!-- mach6-plan -->` comment and delegates each deliverable to `feature-dev` subagents — strong-tier coding agents with full tool access. Independent deliverables run in parallel.

**Fix mode** (with finding numbers or `ci`): Reads review and assessment comments via HTML markers, delegates fixes to `feature-dev` subagents, applies batch sizing heuristics (~10 simple, ~6 moderate, ~3 complex fixes per batch), and suggests `/skill:mach6-push` then `/skill:mach6-review` after fixing.

### mach6-publish

Pre-merge checks, merge, tag, and release.

```
/skill:mach6-publish 53
```

- Verifies CI passing, no merge conflicts, all findings addressed
- Runs pre-merge checklist (docs, version bump, changelog, tests)
- Applies any needed pre-merge updates
- Merges with `--squash --delete-branch`
- Optionally creates a git tag and GitHub release

## Agents

### feature-dev

Strong general-purpose coding agent used by `mach6-implement` for plan implementation and fix application. Has full tool access (read, write, edit, grep, find, ls, bash) and uses a strong-tier model with provider fallback list. Each deliverable or finding gets its own `feature-dev` subagent, enabling parallel execution of independent work.

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
- **Independent assessment** — Review findings are independently verified before suggesting fixes, separating genuine issues from nitpicks and false positives.
- **Iterative review cycles** — Review → fix → push → review, repeating until no genuine issues remain.
- **Safe git** — Never `git add -A`, never stage secrets, stage files by name.
- **Overridable** — Both skills and review agents can be overridden by placing files with the same name in `~/.dreb/agent/skills/` or `~/.dreb/agents/` (user-level) or `.dreb/skills/` or `.dreb/agents/` (project-level).

## Requirements

mach6 uses the [GitHub CLI](https://cli.github.com/) (`gh`) for all GitHub operations. Make sure it's installed and authenticated:

```bash
gh auth status
```
