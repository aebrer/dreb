---
name: mach6-review
description: "Run round-aware specialist review, post unverified candidates, then assess practical merge blockers with adversarial counter-pressure. Usage: mach6-review 42 [aspects]"
argument-hint: "<pr-number> [code|errors|tests|completeness|simplify]"
---

# mach6-review — Round-Aware Multi-Agent PR Review

**User input:** $ARGUMENTS

## Global Rules

1. GitHub is shared memory. Post two comments in every round: `<!-- mach6-review -->`, then `<!-- mach6-assessment -->` as each body's first line.
2. Never use `#N` in comment bodies; say "finding N".
3. Track work with `tasks_update`.
4. Set `GH_PAGER=cat` and `GH_EDITOR=cat` for every `gh` command. Use `--body-file` with a unique `mktemp /tmp/gh-comment.$$.XXXXXXXX` file.
5. Formal review runs only from an explicit user request; never invoke it autonomously or start a review-fix-review loop.
6. Review durable work only. Do not review uncommitted or unpushed work.
7. Do not fix findings in this session; fixes require a later user-invoked `/skill:mach6-implement`.

## Step 1: Track tasks

Track prepare, phase-one review, findings comment, phase-two assessment, assessment comment, and summary; keep at most one task in progress.

## Step 2: Parse input

Extract the required PR number and optional aspects: `code`, `errors`, `tests`, `completeness`, `simplify`.

## Step 3: Prepare, determine the round, and establish the delta

Before checkout, run `git status --porcelain`. If non-empty, stop and use `suggest_next` to offer `/skill:mach6-push`.

```bash
gh pr checkout <pr-number>
git pull --ff-only
test -z "$(git status --porcelain)"
LOCAL_HEAD="$(git rev-parse HEAD)"
PR_HEAD="$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')"
test "$LOCAL_HEAD" = "$PR_HEAD"
```

If either durable-work check fails, stop without marking ready, posting, or launching agents and offer `/skill:mach6-push`. `PR_HEAD` is the exact reviewed commit.

Read the PR body, all comments, files, linked original issue and discussion, latest `<!-- mach6-plan -->`, and subsequent human-approved scope updates. Prior findings and assessments are evidence, not scope authority.

Count comments whose bodies start with `<!-- mach6-review -->`:

```bash
PR_CONTEXT="$(gh pr view <pr-number> --json title,body,comments,files,headRefOid)"
PRIOR_ROUNDS="$(printf '%s' "$PR_CONTEXT" | jq '[.comments[] | select(.body | startswith("<!-- mach6-review -->"))] | length')"
REVIEW_ROUND="$((PRIOR_ROUNDS + 1))"
```

For round 3+, extract the most recent parseable full SHA after `Reviewed commit:` in the latest review comment. If found, use `git log <sha>..HEAD` and `git diff <sha>..HEAD`; this delta and its interactions are the review target. Also extract previous merge blockers and verify that each is fixed. Reject unchanged-code findings unless a delta change makes the issue newly reachable. If no legacy SHA is parseable, review the full PR diff but retain all round-3+ rules.

For rounds 1–2, use `gh pr diff <pr-number>`. Mark the PR ready only after all checks pass: `gh pr ready <pr-number>`.

## Step 4: Phase one — specialist candidates

Agent mapping: `code` → `code-reviewer`; `errors` → `error-auditor`; `tests` → `test-reviewer`; `completeness` → `completeness-checker`; `simplify` → `simplifier`.

Without targeted aspects:
- Rounds 1–2: run `code-reviewer`, applicable `error-auditor`, applicable `test-reviewer`, applicable `completeness-checker`, and `simplifier` together in one parallel `subagent` `tasks` call.
- Round 3+: run the same four core specialists together on the delta. `test-reviewer` remains present when testable code changed. Skip `simplifier` unless `simplify` was explicitly requested.

With targeted aspects, run only mapped agents, while preserving round-3+ delta constraints. Never run simplifier serially after the others.

Give every agent changed paths, full PR context, authoritative scope, actual files, and confidence scoring (0–100; report only candidates at least 80). In round 3+, explicitly provide the base SHA, delta, previous blockers, and unchanged-code rejection rule. Verify previous blockers independently even if no agent reports them.

## Step 5: Post unverified candidates

Always post the phase-one comment, even with no candidates. Severity is reviewer confidence, not an assessed shipping decision.

```markdown
<!-- mach6-review -->
## Unverified Review Candidates — Pending Assessment

**Review round:** N
**Reviewed commit:** <full PR_HEAD SHA>

> These are unverified candidates. Severity reflects reviewer confidence; do not treat any item as a merge blocker until the assessment comment is posted.

### Critical
...
### Important
...
### Suggestions
...
### Strengths
...

**Agents run:** ...

---
*Reviewed by mach6*
```

Post with a unique temp file and `gh pr comment <pr-number> --body-file "$GH_BODY"`; save the returned/latest comment URL.

## Step 6: Phase two — assess with counter-pressure

All assessors receive identical candidate findings, actual code, full PR/issue context, verbatim original quoted requests, acceptance criteria, approved scope changes, review round, and delta context.

Apply three gates:
1. **Factual:** current code contains the problem.
2. **Scope:** fixing it is required by authoritative scope or a PR-introduced material regression.
3. **Practical:** shipping plausibly causes meaningful harm in supported use, through a credible attacker/system failure, or directly violates an explicit acceptance criterion.

Rounds 1–2: launch `independent-assessor` alone.

Round 3+: launch `independent-assessor`, `developers-advocate`, and `devils-advocate` together in one parallel `subagent` `tasks` call. This preserves model-family diversity where available. The devil's advocate supplements, never replaces, `test-reviewer` and attacks acceptance evidence. The developer's advocate attacks the practical value of proposed work and cannot generate findings.

In round 3+, a candidate is a merge blocker only when both the independent assessor and developer's advocate find material practical impact. Do not vote or average confidence. When they disagree, the parent adjudicates by writing a concrete actor, exact reachable trigger sequence, resulting user harm or attacker capability, existing safeguards, and material outcome of fixing it. Without that concrete trigger-and-outcome sequence, it is not a merge blocker. Use devil's-advocate output to determine the minimal missing acceptance evidence, not to manufacture unrelated findings.

Missing tests are not blockers by themselves: identify the important regression, practical consequence, and why current tests miss it.

## Step 7: Post assessment

Post the second comment with a unique temp body:

```markdown
<!-- mach6-assessment -->
## Review Assessment

<link to findings comment>

### Classifications
| Finding | Classification | Reasoning |
|---|---|---|
| ... | merge blocker / useful follow-up / discarded observation / nitpick / false positive / deferred | **Factual:** ... **Scope:** ... **Practical:** ... |

### Action Plan
<merge blockers only, ordered by priority>

---
*Assessment by mach6*
```

Classify every candidate. Useful follow-ups and deferred observations stay outside the action plan.

## Step 8: CLI summary

Report each classification, counts of merge blockers/nitpicks/false positives/deferred, and the merge-blocker-only action plan. Ask whether to create issues for deferred follow-ups, using unique temp body files.

Suggest exactly one next command:
- Merge blockers: `/skill:mach6-implement <pr-number> <finding-numbers>`
- No merge blockers: `/skill:mach6-publish <pr-number>`
