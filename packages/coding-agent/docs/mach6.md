# mach6 — Development Workflow

mach6 is a built-in workflow that orchestrates the full issue-to-merge lifecycle using GitHub as shared memory. Six skills cover each stage of development, with round-aware specialist review and three independent assessment agents providing deliberate counter-pressure.

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

**Assess mode:** Launches parallel Explore agents to retrieve bounded code/documentation evidence, then has the primary agent synthesize and post the assessment (summary, gaps, ambiguities, scope, risks) as an issue comment.

**Create mode:** Drafts a structured issue with title, summary, acceptance criteria, and technical notes.

### mach6-plan

Explore the codebase, create an implementation plan, open a draft PR, and post the plan as a PR comment.

```
/skill:mach6-plan 42
```

- Reads the issue and any existing assessment
- Checks project conventions (AGENTS.md, CONTRIBUTING.md, etc.)
- Launches parallel Explore agents to locate related implementations, enumerate explicit flows/call sites, and quote bounded evidence; the primary agent owns architecture and planning
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

Run a durable, explicit, round-aware review. It always posts two comments: an **unverified candidates pending assessment** comment recording the review round and exact reviewed commit SHA, followed by an assessment comment whose action plan contains merge blockers only.

```
/skill:mach6-review 53
/skill:mach6-review 53 code errors
/skill:mach6-review 53 tests
```

Every round runs the applicable code-reviewer, error-auditor, test-reviewer, completeness-checker, and simplifier together in phase one. A specialist is retried rather than omitted if dispatch arbitration or the agent fails. In rounds 1–2, the independent assessor then applies factual, scope, and practical gates. Practical assessment requires a credible actor, exact reachable trigger, concrete consequence, existing safeguards, and material value from fixing the problem; missing tests are not blockers without an important uncovered regression.

Round 3+ continues to review the full PR and all interactions among its changes while using changes since the latest recorded reviewed SHA as supplemental context for verifying prior blockers and identifying new work. Reviews narrow only when the user explicitly requests a targeted scope. Phase two runs independent-assessor, developers-advocate, and devils-advocate in parallel. The developer's advocate attacks the practical value of proposed work; the devil's advocate attacks evidence that the original acceptance promises hold and supplements rather than replaces test-reviewer. A later-round item blocks merge only when the assessor and developer's advocate agree on material practical impact, with parent adjudication based on a concrete trigger-and-outcome sequence.

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

- Checks conflicts and merge blockers, performs version/docs pushes directly, then makes one final blocking `watch_github_ci` call immediately before merge
- Runs pre-merge checklist (version bump, tests)
- Applies version bump on the feature branch
- Proactively reviews and updates ALL documentation affected by the PR's changes
- Merges with `--squash --delete-branch`
- Optionally creates a git tag and GitHub release

## Agents

### feature-dev

Strong general-purpose coding agent optionally used by `mach6-implement` for precisely specified execution. It has full tool access (read, write, edit, grep, find, ls, bash, search) and uses a strong-tier model with a provider fallback list. The parent model retains design ownership and may implement directly; `feature-dev` is most useful for high-volume, repetitive work with settled decision rules.

### Review Agents

Phase one uses specialists with orthogonal incentives and confidence-scored candidate findings:

| Agent | Question | Round behavior |
|---|---|---|
| **code-reviewer** | Is the implementation correct and idiomatic? | All applicable rounds |
| **error-auditor** | What can fail silently at runtime? | All applicable rounds |
| **test-reviewer** | What important behavior lacks coverage? | All applicable rounds; never replaced |
| **completeness-checker** | Does the PR fulfill authoritative scope? | All applicable rounds |
| **simplifier** | Can changed code be clearer without behavior changes? | Every round; retry on dispatch or agent failure |

Phase two assessment agents:

| Agent | Incentive |
|---|---|
| **independent-assessor** | Apply factual, scope, and practical gates; classify merge blockers |
| **developers-advocate** | Make the strongest honest case that proposed work has no practical value |
| **devils-advocate** | Design adversarial tests intended to disprove the original acceptance promises |

The two advocates intentionally pull in different directions: one challenges the value of fixing candidates, while the other challenges whether acceptance evidence is strong enough. Both join the assessor only in round 3+.

**Targeted review:** `code`, `errors`, `tests`, `completeness`, or `simplify` selects corresponding phase-one agents.

## Design Principles

- **GitHub as shared memory** — Plans, reviews, assessments, and progress are posted as PR/issue comments with HTML markers (`<!-- mach6-plan -->`, `<!-- mach6-review -->`, etc.) so any future session can pick up context.
- **Three-gate independent assessment** — Findings must be factual, authorized, and materially practical before becoming merge blockers.
- **Deliberate counter-pressure** — Every round reviews the full PR; later-round deltas supplement that view for fix verification while practical-value skepticism and adversarial acceptance evidence resist ceremonial review work.
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
