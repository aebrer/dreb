---
name: model-routing-guide
description: Research the explicitly scoped models and generate a local evidence-based guide for choosing subagent roles, models, and thinking levels. This is a user-triggered, potentially expensive research workflow.
argument-hint: "[comma-separated model patterns]"
disable-model-invocation: true
user-invocable: true
---

# model-routing-guide — Generate the Subagent Routing Guide

**Explicit model patterns, when supplied:** $ARGUMENTS

Generate or replace `~/.dreb/agent/model-routing-guide.md`. This is a deep research workflow, not a quick opinion. Use normal dreb tools (`read`, `bash`, `find`, `grep`, `web_search`, `web_fetch`, and the Reddit reader when applicable); no special runtime support is required.

## Non-negotiable routing goals

The guide must help a later dispatcher make two especially important corrections:

1. **Agent-role fit:** `Explore` is for factual collection, codebase navigation, file discovery, web research, and answering bounded questions. Planning, architecture ownership, implementation, editing, and feature development are not Explore work. Explicitly call out examples such as a planning workflow delegating its plan to Explore, or a feature-development task being sent to Explore.
2. **Capability/cost fit:** routine fact checks, repetitive inspection of many mundane files, lookup, extraction, and straightforward summarization should use the least expensive/lowest-latency scoped model that the evidence shows is adequate. Reserve frontier or strongest-tier models for tasks whose complexity, ambiguity, risk, or demonstrated failure rate justifies them.

Do not turn the guide into a generalized policy engine. Research the user's actual scoped provider/model combinations and give practical recommendations for the existing dreb agent roles.

## Step 1: Establish the exact explicit scope

1. If the text after `Explicit model patterns, when supplied:` is non-empty, treat it as the authoritative comma-separated model-pattern scope. This supports passing the same patterns used with `--models`.
2. Otherwise read `enabledModels` from the normal readable settings files:
   - global: `~/.dreb/agent/settings.json`
   - project: `.dreb/settings.json` in the current working directory, when present (project settings override the global value)
3. Do not infer a scope from the current model, agent-definition defaults, all authenticated models, or `agentModels.models`.
4. If there is no non-empty explicit pattern list, **stop with an actionable error before researching or writing a guide**.
5. List the available models with the installed dreb CLI and resolve every pattern to canonical `provider/model` IDs using dreb's normal case-insensitive exact/glob matching semantics. Preserve provider identity: the same upstream model through two providers is two candidates.
6. Fail loudly if any supplied pattern resolves to no candidate or if the model listing cannot be obtained.
7. Compare the resolved candidate set with the complete available-model set. If they are equal, or the explicit patterns otherwise amount to unbounded all-model research (for example a bare `*`), **refuse and ask the user for a narrower scope**.

Keep the canonical candidate list. It is the coverage checklist for every later step.

## Step 2: Snapshot and validate local subagent evidence

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

## Step 3: Research every canonical provider/model

Research each candidate as the canonical provider/model combination, not only the upstream model family. Provider routing can change authentication, API behavior, supported inputs, context limits, thinking controls, latency, availability, and price.

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
- **Local observation** — sanitized aggregate from Step 2.

Research coding, exploration, review, planning, tool use, instruction following, long-context behavior, vision, latency, cost, and supported thinking levels. Record contrary evidence and unknowns. Do not fill a required field with a guess: write `Unknown` and lower confidence when reliable evidence is absent.

Reconcile external and local evidence explicitly. If they disagree, preserve the disagreement and explain the likely limits (sample size, provider differences, workload mismatch, version drift) rather than choosing the more flattering result.

## Step 4: Write the guide

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

## Step 5: Validate before reporting success

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
