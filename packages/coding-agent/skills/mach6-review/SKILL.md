---
name: mach6-review
description: "Run specialized review agents in parallel on a PR (code-reviewer, error-auditor, test-reviewer, completeness-checker, simplifier), post findings, then independently assess each finding to separate genuine issues from nitpicks and false positives. Usage: mach6-review 42 [aspects]"
argument-hint: "<pr-number> [code|errors|tests|completeness|simplify]"
---

# mach6-review — Multi-Agent PR Review

**User input:** $ARGUMENTS

## Global Rules

1. **GitHub as shared memory** — Reviews and assessments are posted as PR comments so any future session can pick up context.
2. **HTML markers** — Use `<!-- mach6-review -->` and `<!-- mach6-assessment -->` as the first line of comment bodies.
3. **No `#N` in comment bodies** — Use "finding 3", "item 3", "stage 2" etc. instead.
4. **Task tracking** — Use the `tasks_update` tool to show progress.

**Important: Do NOT fix any issues in this session. Fixes happen via `/skill:mach6-fix`.**

## Step 1: Set up task tracking

```
tasks_update([
  { id: "prepare", title: "Prepare — checkout and gather context", status: "in_progress" },
  { id: "review", title: "Run review agents", status: "pending" },
  { id: "post-review", title: "Post review findings", status: "pending" },
  { id: "assess", title: "Independent assessment", status: "pending" },
  { id: "post-assess", title: "Post assessment", status: "pending" },
  { id: "summary", title: "Present CLI summary", status: "pending" }
])
```

## Step 2: Parse input

Extract:
- **PR number** (required)
- **Review aspects** (optional) — if specified, only run matching agents

## Step 3: Prepare

```bash
gh pr checkout <pr-number>
git pull
```

Gather PR context:
```bash
gh pr view <pr-number> --json title,body,comments,files
gh pr diff <pr-number>
```

Read the PR description, linked issue, and any plan comments. Identify changed files and their content.

Update task: prepare → completed, review → in_progress.

## Step 4: Select and run review agents

**Available review agents:**

These agents are **pre-existing agent definitions** shipped with dreb — do not redefine them inline. Reference them by name via the `agent` parameter in `subagent`. They default to `model: sonnet` (mid-tier reasoning model). If your current provider doesn't carry models matching "sonnet", pass a `model` override with your provider's equivalent mid-tier model (e.g., `glm-5-turbo` on z.ai).

| Agent | Question | When to run |
|---|---|---|
| `code-reviewer` | "Does this code do what it should, correctly and idiomatically?" | Always |
| `error-auditor` | "What can go wrong silently at runtime?" | If error handling / try-catch / fallback logic touched |
| `test-reviewer` | "What behaviors are untested or poorly tested?" | If test files changed or testable code added |
| `completeness-checker` | "Does this PR deliver everything the linked issue requires?" | If PR links to an issue |
| `simplifier` | "Can this be expressed more clearly without changing behavior?" | Always (runs last, after others) |

**Targeted review:** If the user specified aspects, only run matching agents:
- `code` → code-reviewer
- `errors` → error-auditor
- `tests` → test-reviewer
- `completeness` → completeness-checker
- `simplify` → simplifier

**For each agent**, launch via the `subagent` tool with `background=true`. Run `code-reviewer`, `error-auditor`, `test-reviewer`, and `completeness-checker` in parallel. Run `simplifier` after the others complete.

Provide each agent with:
- The list of changed files with paths
- The PR description and linked issue context
- Instructions to read the actual changed files for full context

All agents use confidence scoring (0-100, only report findings ≥ 80).

Update task: review → completed, post-review → in_progress.

## Step 5: Post review findings

Compile all findings from all agents into a single structured comment:

```bash
gh pr comment <pr-number> --body "<!-- mach6-review -->
## Code Review

### Critical
<findings with severity: critical, if any>

### Important
<findings with severity: high, if any>

### Suggestions
<findings with severity: medium or low, if any>

### Strengths
<notable positive observations>

**Agents run:** <list of agents>

---
*Reviewed by mach6*"
```

Save the review comment URL:
```bash
gh pr view <pr-number> --json comments --jq '.comments[-1].url'
```
Extract the numeric comment ID from the URL (the number after `issuecomment-`).

Update task: post-review → completed, assess → in_progress.

## Step 6: Independent assessment

Launch a subagent with `agent: "independent-assessor"`. This is a **pre-existing agent definition** shipped with dreb — it has full codebase read access and defaults to `model: opus` (strongest tier). If your provider doesn't carry models matching "opus", pass a `model` override with your provider's strongest model (e.g., `glm-5-1` on z.ai).

**Do NOT use the Sandbox agent for this step** — the Sandbox agent has no codebase access and cannot verify findings against actual code.

Provide the assessor with:
- The full review text
- The PR context (title, body, comments)
- Instructions to **read the actual code** for each finding and verify independently

The assessor classifies each finding as:
- **Genuine issue** — Real problem, should fix before merge. Explain why.
- **Nitpick** — Stylistic, doesn't affect correctness. Explain why it doesn't matter.
- **False positive** — Not actually an issue. Explain why the code is correct.
- **Deferred** — Real issue but out of scope. Should track separately.

If a finding was already addressed in prior commits or PR discussion, classify as false positive with a note.

After classifying all findings, produce an **action plan** listing what to fix, in what order.

Update task: assess → completed, post-assess → in_progress.

## Step 7: Post assessment

```bash
gh pr comment <pr-number> --body "<!-- mach6-assessment -->
## Review Assessment

<link to review comment>

### Classifications

| Finding | Classification | Reasoning |
|---|---|---|
| <summary> | genuine/nitpick/false-positive/deferred | <1-2 sentences> |

### Action Plan

<numbered list of what to fix, ordered by priority>

---
*Assessment by mach6*"
```

Update task: post-assess → completed, summary → in_progress.

## Step 8: CLI summary

Present to the user:
- Per-finding breakdown: summary, classification, reasoning
- Counts: genuine, nitpicks, false positives, deferred
- Action plan

If any findings were classified as **deferred**, ask the user if they want to create issues for them:
```bash
gh issue create --title "<title>" --body "<body referencing PR and finding>"
```

Update task: summary → completed.

Suggest next step:
- If genuine issues: `/skill:mach6-fix <pr-number> <finding-numbers>`
- If all clear: `/skill:mach6-publish <pr-number>`
