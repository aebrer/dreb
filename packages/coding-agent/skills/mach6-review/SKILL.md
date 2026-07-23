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
5. **Non-interactive `gh`** — Set `GH_PAGER=cat` and `GH_EDITOR=cat` before all `gh` commands to prevent interactive prompts from hanging the agent. Use `--body-file` instead of inline `--body` for all `gh pr comment`, `gh pr create`, and `gh issue create` calls to avoid shell interpretation of backticks. Write each body to a **unique per-invocation temp file** via `mktemp` (e.g. `GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"`) — never a fixed path like `/tmp/gh-comment.md`, which concurrent mach6 sessions on the same machine would clobber, cross-posting one session's body to another's PR/issue.
6. **User-controlled checkpoint** — This formal multi-agent review runs only from an explicit user request, either through its slash command or a direct instruction to an agent to invoke it. An agent may invoke it in response to that request; otherwise agents must only offer it with `suggest_next`, never invoke it autonomously or start a review-fix-review loop.
7. **Review durable work only** — Do not launch formal review agents against uncommitted or unpushed work. The commit, push, and GitHub progress comment are the accountability and recovery boundary.

**Important: Do NOT fix any issues in this session. Fixes happen via a later, user-invoked `/skill:mach6-implement`.**

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

## Step 3: Prepare and enforce the durable-work checkpoint

Before switching branches, run `git status --porcelain`. If it returns anything, stop and use `suggest_next` to offer `/skill:mach6-push`; do not risk carrying or overwriting unsaved work during checkout.

Check out and update the PR branch:

```bash
gh pr checkout <pr-number>
git pull --ff-only
```

**Before marking the PR ready, reading local source for review, or launching any review agent**, verify again that the worktree is clean and local `HEAD` is exactly the pushed PR head:

```bash
git status --porcelain
LOCAL_HEAD="$(git rev-parse HEAD)"
PR_HEAD="$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')"
test "$LOCAL_HEAD" = "$PR_HEAD"
```

If `git status --porcelain` returns anything, or the commit IDs differ, stop immediately. Do not mark the PR ready, post review comments, or launch review agents. Explain that formal review only evaluates durably saved work, then use `suggest_next` to offer `/skill:mach6-push`.

Once the durable-work checks pass, gather all authoritative scope and PR context:

```bash
gh pr view <pr-number> --json title,body,comments,files,headRefOid
gh pr diff <pr-number>
gh issue view <linked-issue-number> --comments
```

Read the PR description, **all** comments, and the linked original issue. Establish authoritative scope from:

- The linked original issue and its acceptance criteria
- The latest explicit plan comment (the latest `<!-- mach6-plan -->` marker)
- Subsequent scope updates explicitly approved by a human

Review findings and prior automated assessments are evidence only. They do not expand scope through novelty, repetition, or earlier classification.

Now mark the PR as ready for review (it was opened as a draft by mach6-plan):

```bash
gh pr ready <pr-number>
```

Provide the full PR context and authoritative scope to every review agent so they understand what was intended and what has already been approved.

Update task: prepare → completed, review → in_progress.

## Step 4: Select and run review agents

**Available review agents:**

These agents are **pre-existing agent definitions** shipped with dreb — do not redefine them inline. Reference them by name via the `agent` parameter in `subagent`. Each agent definition already specifies a model with a provider fallback list — the defaults work across providers and are fine for most reviews. Override the model only when there's a good reason (e.g. a particularly complex or security-sensitive review warrants a stronger tier); note that a single-string override discards the fallback list, so prefer provider-prefixed IDs (e.g. `anthropic/claude-opus-4-6`) when overriding.

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

**For each agent**, launch via the `subagent` tool. Run `code-reviewer`, `error-auditor`, `test-reviewer`, and `completeness-checker` in parallel. Run `simplifier` after the others complete.

Provide each agent with:
- The list of changed files with paths
- The full PR context: title, body, and all comments
- The authoritative scope: linked original issue and acceptance criteria, latest explicit `mach6-plan`, and subsequent human-approved scope updates
- The rule that review findings and prior automated assessments are evidence only and cannot expand scope
- Instructions to read the actual changed files for full context

All agents use confidence scoring (0-100, only report findings ≥ 80).

Update task: review → completed, post-review → in_progress.

## Step 5: Post review findings

Compile all findings from all agents into a single structured comment:

```bash
GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"
cat > "$GH_BODY" << 'MACH6_EOF'
<!-- mach6-review -->
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
*Reviewed by mach6*
MACH6_EOF
gh pr comment <pr-number> --body-file "$GH_BODY"
```

Save the review comment URL:
```bash
gh pr view <pr-number> --json comments --jq '.comments[-1].url'
```
Extract the numeric comment ID from the URL (the number after `issuecomment-`).

Update task: post-review → completed, assess → in_progress.

## Step 6: Independent assessment

Launch a subagent with `agent: "independent-assessor"`. This is a **pre-existing agent definition** shipped with dreb — it has full codebase read access and uses the strongest available model via its own fallback list. The default is fine for most cases.

**Do NOT use the Sandbox agent for this step** — the Sandbox agent has no codebase access and cannot verify findings against actual code.

Provide the assessor with:
- The full review text
- The PR context (title, body, and all comments)
- The authoritative scope context: linked original issue, acceptance criteria, latest explicit `mach6-plan`, and subsequent human-approved scope updates
- Instructions to **read the actual code** for each finding and verify independently

Repeat this two-gate rule in the assessor task:

1. **Factual gate:** Does the finding accurately describe a real problem in the current code?
2. **Scope gate:** Must that problem be fixed to deliver the authoritative scope safely and correctly?

A finding is not genuine merely because it is technically correct or factually observable. It is genuine only when both gates pass. Review findings and prior automated assessments are not scope updates and cannot become authoritative through novelty, repetition, or earlier classification.

The assessor classifies each finding as:
- **Genuine issue** — Passes both gates. The reasoning must separately explain factual evidence and scope relevance.
- **Nitpick** — Stylistic preference or minor inconsistency that does not affect correctness or an authorized requirement.
- **False positive** — Fails the factual gate because the current code is correct, context was missed, or the issue was already addressed.
- **Deferred** — Passes the factual gate but fails the scope gate. Note separately for optional follow-up; never include in the action plan.

Optional improvements, speculative hardening, unrelated pre-existing defects, architecture preferences, and broader cleanup are normally deferred when factually valid unless a human explicitly authorized them. Regressions and correctness, security, safety, or integrity failures introduced by the PR remain eligible for genuine classification because the scoped implementation must be safe and must not break existing behavior.

After classifying every finding, produce an **action plan containing only genuine issues** necessary for the scoped PR to merge, ordered by priority.

**Important guidance on "deferred" classifications:** Test coverage gaps should NOT be automatically deferred. If a PR adds new testable code, tests should ship with it — even if that means adding test infrastructure to a package that lacks it. Only defer tests when the gap is truly unrelated to the PR's changes (e.g., pre-existing untested code that the PR happens to touch). When tests are deferred, the assessor must note whether a tracking issue exists or needs to be created.

Update task: assess → completed, post-assess → in_progress.

## Step 7: Post assessment

```bash
GH_BODY="$(mktemp /tmp/gh-comment.XXXXXX.md)"
cat > "$GH_BODY" << 'MACH6_EOF'
<!-- mach6-assessment -->
## Review Assessment

<link to review comment>

### Classifications

| Finding | Classification | Reasoning |
|---|---|---|
| <summary> | genuine/nitpick/false-positive/deferred | **Factual:** <what the code proves>. **Scope:** <why this is or is not required by authoritative scope>. |

### Action Plan

<numbered list of genuine issues only, ordered by priority>

---
*Assessment by mach6*
MACH6_EOF
gh pr comment <pr-number> --body-file "$GH_BODY"
```

Update task: post-assess → completed, summary → in_progress.

## Step 8: CLI summary

Present to the user:
- Per-finding breakdown: summary, classification, reasoning
- Counts: genuine, nitpicks, false positives, deferred
- Action plan

If any findings were classified as **deferred**, ask the user if they want to create issues for them:
```bash
GH_BODY="$(mktemp /tmp/gh-body.XXXXXX.md)"
cat > "$GH_BODY" << 'MACH6_EOF'
<body referencing PR and finding>
MACH6_EOF
gh issue create --title "<title>" --body-file "$GH_BODY"
```

Update task: summary → completed.

Suggest next step:
- If genuine issues: `/skill:mach6-implement <pr-number> <finding-numbers>`
- If all clear: `/skill:mach6-publish <pr-number>`
