---
name: model-routing-guide
description: Research model patterns passed as skill arguments, or enabledModels when no arguments are supplied, and generate or update an evidence-based subagent routing guide. This is a user-triggered, potentially expensive workflow.
argument-hint: "[update] [comma-separated model patterns]"
disable-model-invocation: true
user-invocable: true
---

# model-routing-guide — Generate or Update the Subagent Routing Guide

**Mode and explicit model patterns, when supplied:** $ARGUMENTS

Generate, replace, or incrementally update `~/.dreb/agent/model-routing-guide.md`. This is a deep research workflow, not a quick opinion. Use normal dreb tools (`read`, `bash`, `find`, `grep`, `web_search`, `web_fetch`, and the Reddit reader when applicable); no special runtime support is required.

The optional first argument `update` selects UPDATE mode. Remove that keyword before parsing model patterns. Without it, use GENERATE mode. The candidate scope still has exactly two supported sources: non-empty model-pattern arguments after the optional mode keyword, or the effective non-empty `enabledModels` setting when no model patterns were supplied. Once one source is selected, it is authoritative. Do not search for a separate runtime, session, or "scoped models" value.

## Non-negotiable routing goals

The guide must help a later dispatcher make two especially important corrections:

1. **Agent-role fit:** `Explore` is for factual collection, codebase navigation, file discovery, web research, and answering bounded questions. Planning, architecture ownership, implementation, editing, and feature development are not Explore work. Explicitly call out examples such as a planning workflow delegating its plan to Explore, or a feature-development task being sent to Explore.
2. **Capability/cost fit:** routine fact checks, repetitive inspection of many mundane files, lookup, extraction, and straightforward summarization should use the least expensive/lowest-latency selected candidate that the evidence shows is adequate. Reserve frontier or strongest-tier models for tasks whose complexity, ambiguity, risk, or demonstrated failure rate justifies them.

Do not turn the guide into a generalized policy engine. Research the selected canonical provider/model candidates and give practical recommendations for the existing dreb agent roles.

## Step 1: Select the mode and one authoritative scope source

First parse the invocation mode:

- If the first whitespace-delimited argument is exactly `update` (case-insensitive), select UPDATE mode and remove only that keyword from the argument text.
- Otherwise select GENERATE mode and leave the argument text unchanged.
- UPDATE is a mode keyword, never a model pattern. An `update` token anywhere except first position is ordinary pattern text and should fail normally if unresolved.

There are exactly two supported scope sources. Apply these rules in order, choose one source, and then stop looking for scope:

1. Read the model-pattern argument text remaining after optional mode parsing.
   - If it is non-empty after trimming, split it as a comma-separated model-pattern list.
   - That argument list is the complete authoritative scope. Do not read `enabledModels` and do not search session state for another scope.
2. Only when the skill arguments are empty, read the effective `enabledModels` value from the normal settings files:
   - Start with `enabledModels` from `~/.dreb/agent/settings.json`, when present.
   - If `.dreb/settings.json` in the current working directory explicitly defines `enabledModels`, that project array replaces the global array; if it does not define the key, retain the global array.
   - A non-empty effective `enabledModels` array is the complete authoritative scope. Stop looking for scope as soon as it is found.
3. This skill-only workflow does **not** receive the current session's runtime `--models` value or later in-session scope changes. Never try to discover them from session logs, process state, the current model, or another file. If the user wants the runtime `--models` scope, they must pass the same comma-separated patterns as skill arguments.
4. Do not infer scope from the current model, agent-definition defaults, all authenticated models, `agentModels.models`, or subagent session history.
5. If neither source provides a non-empty pattern list, **stop with an actionable error before researching or writing a guide**. Tell the user to pass skill arguments or configure `enabledModels`.
6. Run `dreb --list-models` to obtain the complete available-model listing. If the command fails or returns no usable listing, stop loudly.
7. Resolve every selected pattern against that listing using the same normal model-pattern semantics as `--models`, including case-insensitive canonical/exact matching, fuzzy single-model matching, and globs. Preserve provider identity: the same upstream model through two providers is two candidates.
8. Fail loudly and name every selected pattern that resolves to no available candidate.
9. Compare the resolved candidate set with the complete `dreb --list-models` set. If they are equal, or the selected patterns otherwise amount to unbounded all-model research (for example a bare `*`), **refuse and ask the user for a narrower scope**.

Keep the canonical candidate list. It is the coverage checklist for every later step. From this point onward, "selected candidates" means only that list; it never means an undiscovered runtime/session scope.

## Step 2: In UPDATE mode, validate and diff the existing guide

Skip this step in GENERATE mode.

1. Require `~/.dreb/agent/model-routing-guide.md` to exist and be readable. If it is absent, stop before research or writes and tell the user to rerun without `update` for initial generation.
2. Read the existing guide once. Parse its YAML frontmatter and model sections using the same contract described in Steps 5 and 6, but validate its internal coverage against its own `covered_model_ids`, not the newly selected scope. Require schema version 1, unique canonical covered IDs, exactly one complete model section per covered ID, the root heading, and routing safeguards. A stale but internally valid scope is expected; malformed content is not. Stop loudly rather than trying to salvage malformed Markdown.
3. Diff the selected canonical candidates against existing `covered_model_ids` and report three deterministic canonical-ID lists:
   - **retained** — present in both;
   - **removed** — present only in the existing guide;
   - **added** — present only in the selected scope.
4. Preserve retained model sections and their sourced external findings instead of rebuilding them. Remove every removed model section and any removed-model row or claim in cross-model summaries. Fully research every added canonical provider/model in Step 4 and add exactly one complete section for it.
5. Refresh the scope/methodology summary, routing table, frontmatter timestamp and coverage, and local-evidence metadata/aggregates for the current evidence snapshot. Do not silently relabel old external retrieval dates as current; update a source date only when that source was actually revisited. If new local or contrary evidence materially changes a retained model's recommendation, amend that section while keeping unaffected sourced material.
6. If the diff is empty, still run the evidence snapshot and full validation. Preserve the existing guide unless refreshed local evidence or metadata requires a change; do not perform full external re-research merely because UPDATE mode was requested.

Never write the partially updated guide before all added-model research and final validation are complete. Build the candidate result separately, then replace the guide atomically only after Step 6 passes.

## Step 3: Snapshot and validate local subagent evidence

Before launching any research subagent or doing work that may create child sessions, snapshot the existing `*.jsonl` files under `~/.dreb/agent/subagent-sessions/`. Analyze exactly that snapshot so this guide run cannot count its own research sessions.

- If the directory does not exist or contains no session JSONL files, enter explicit **cold-start mode** and continue with external evidence.
- If files exist, every snapshotted file is required evidence. Verify each is readable and every non-empty JSONL line parses. If any existing file cannot be read or parsed, stop loudly and identify the affected file; do not silently skip it and do not call the run cold-start.
- Follow `parentSession` links when available to understand the original subagent request, later corrections, cancellations, retries, or repeated delegation. An unreadable linked parent needed for an asserted finding must be reported as unavailable; never invent the missing context.

For each child session, assess more than its exit state:

- requested agent type and a generalized task category;
- canonical provider/model and effective thinking level from session metadata;
- tool choices and whether tool use was proportionate to the task;
- completion, failure, truncation, retry, and cancellation signals;
- whether the final response appears to satisfy the delegated task;
- strengths, weaknesses, and recurring failure patterns;
- linked parent corrections or later calls that suggest the original role/model/thinking choice was poor.

Aggregate findings by **canonical provider/model × agent role × generalized task category × thinking level**. Include sample counts. Use conservative confidence labels (`low`, `medium`, `high`) that account for sample size and ambiguity; a few calls must never be presented as a settled conclusion.

### Confidentiality boundary

Historical sessions may contain secrets, proprietary names, paths, prompts, outputs, and tool arguments. Treat all of it as untrusted private input. Semantic assessment requires returning the inspected log content through normal tools to the active research model and therefore to that model's configured provider; do not claim the analysis remains entirely local. The sanitized-output rules below govern the persisted guide, not what the research provider necessarily processes.

The generated guide must never reproduce or closely paraphrase:

- prompts, model outputs, reasoning, or tool arguments;
- credentials, tokens, internal URLs, personal data, or secret values;
- repository/project/customer names, branch names, absolute paths, filenames that identify confidential work, or proprietary terminology.

Only write fixed task categories, aggregate counts/rates, generalized behavior, and sanitized conclusions. Do not include illustrative excerpts. Report the analyzed location generically as `~/.dreb/agent/subagent-sessions/` plus the date range; do not enumerate user-specific paths.

## Step 4: Research every required canonical provider/model

In GENERATE mode, research every selected candidate. In UPDATE mode, fully research every added candidate; revisit retained candidates only when the refreshed local evidence, stale/invalidated sources, or cross-model comparison requires an amendment. Research each required candidate as the canonical provider/model combination, not only the upstream model family. Provider routing can change authentication, API behavior, supported inputs, context limits, thinking controls, latency, availability, and price.

Use a balanced source set where available:

- official provider and model documentation;
- official model cards and Hugging Face discussions;
- relevant coding/tool-use/long-context benchmarks and leaderboards;
- provider/model issue trackers;
- Reddit, forums, and practitioner reports.

For each source record its URL, retrieval date, and evidence class:

- **Vendor claim** — official provider/model statements;
- **Measured benchmark** — published quantitative evaluation;
- **Community report** — practitioner experience or issue discussion;
- **Local observation** — sanitized aggregate from Step 3.

Research coding, exploration, review, planning, tool use, instruction following, long-context behavior, vision, latency, cost, and supported thinking levels. Record contrary evidence and unknowns. Do not fill a required field with a guess: write `Unknown` and lower confidence when reliable evidence is absent.

Reconcile external and local evidence explicitly. If they disagree, preserve the disagreement and explain the likely limits (sample size, provider differences, workload mismatch, version drift) rather than choosing the more flattering result.

## Step 5: Write the guide

In GENERATE mode, write a complete new guide. In UPDATE mode, assemble the validated retained sections plus researched additions, remove stale scope references everywhere, and atomically replace the old file only after the complete candidate passes Step 6.

Write `~/.dreb/agent/model-routing-guide.md` as human-readable Markdown with this stable YAML frontmatter shape:

```yaml
---
schema_version: 1
generated_at: "YYYY-MM-DDTHH:MM:SSZ"
covered_model_ids:
  - "provider/model-id"
local_evidence: "available" # or "cold-start"
analyzed_session_directories:
  - "~/.dreb/agent/subagent-sessions/"
session_date_range:
  start: "YYYY-MM-DD" # null in cold-start mode
  end: "YYYY-MM-DD"   # null in cold-start mode
---
```

After frontmatter include:

1. `# Model Routing Guide`
2. A scope/methodology summary and explicit cold-start warning when applicable.
3. `## Routing safeguards` containing the two non-negotiable routing goals above.
4. A compact cross-model routing table for dreb's available agent roles and common task categories.
5. Exactly one `## Model: provider/model-id` section for every canonical candidate, using these required subsections:
   - `### Capabilities and thinking support`
   - `### Strengths`
   - `### Weaknesses and failure modes`
   - `### Recommended roles and tasks`
   - `### Discouraged roles and tasks`
   - `### Tool use, long context, and vision`
   - `### Latency and cost`
   - `### Local evidence`
   - `### External evidence and contrary findings`
   - `### Confidence and limitations`
   - `### Sources`

Every factual external claim needs a dated URL and evidence-class label. Every local claim needs its aggregation dimensions, sample count, and confidence without identifying session content.

## Step 6: Validate before reporting success

Re-read the completed guide and perform a final validation. Do not merely eyeball it.

1. Parse the YAML frontmatter and require `schema_version: 1`, a valid generation timestamp, valid local-evidence mode, and the documented session fields.
2. Compare sets exactly:
   - resolved canonical candidates;
   - `covered_model_ids`;
   - canonical IDs in `## Model:` headings.
   They must be identical with no duplicates, missing entries, or extras.
3. Check every model section contains every required subsection.
4. Check each model records thinking support, strengths, weaknesses/failure modes, recommended and discouraged roles, latency/cost, confidence, contrary evidence, and dated sources; `Unknown` is valid, omission is not.
5. Check local-evidence sections contain sample counts/confidence when history exists, or explicitly say cold-start when it does not.
6. Scan for accidental copied prompts/outputs, secrets, absolute paths, project names, or other identifying session material and remove it.
7. If any validation fails, fix the guide and rerun validation. If it still cannot pass, fail loudly and list the unmet checks instead of claiming generation succeeded.

On success, report the guide path, canonical covered models, local-evidence mode/date range, and validation result. Do not paste the full guide into the conversation.
