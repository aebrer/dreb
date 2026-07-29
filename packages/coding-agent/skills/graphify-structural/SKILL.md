---
name: graphify-structural
description: "Optional, bounded AST-only Graphify structural evidence for a concrete repository question. Requires deliberate opt-in; direct source and tests remain authoritative."
argument-hint: "[concrete structural question | symbol | path]"
user-invocable: true
disable-model-invocation: false
---

# Graphify Structural Evidence

Use this built-in skill only for **deliberate, bounded structural evidence**. It is both user-invocable (`/skill:graphify-structural`) and model-invocable, but never automatic: proceed only when the user explicitly opts in or a MACH6 stage supplies one concrete structural question. Direct source and test evidence remains authoritative.

## Safety boundary

Graphify use is optional and AST-only. Do not use or request:

- semantic analysis, models, APIs, or MCP;
- `watch`, hooks, persistent processes, or instruction modes;
- package installation or updates, including installing or updating Graphify;
- `graphify add`;
- visualization or labels, clustering during extraction, or unbounded/repeated queries;
- automatic `.gitignore` changes.

Never modify source solely to satisfy Graphify. Do not stage Graphify artifacts; leave them untracked. If the CLI is unavailable or incompatible, do not substitute another tool or a package install: state that Graphify was skipped and continue with direct source and tests.

## Opt-in and preflight

1. Record the opt-in and one concrete question, symbol, or path. Keep the question structural (for example, "What callers are affected by `parseConfig`?").
2. Confirm a preinstalled `graphify` executable on `PATH` and inspect its non-mutating help surface:

   ```bash
   command -v graphify
   graphify --help
   graphify extract --help
   graphify cluster-only --help
   graphify god-nodes --help
   graphify affected --help
   graphify path --help
   graphify query --help
   graphify update --help
   ```

3. Before any evidence command, confirm that the installed CLI supports every required command and option below, including code-only extraction, worker cap, disabled visualization/labels, query budget, and no query log.
4. If the executable is missing, any help command fails, or the required surface is absent or incompatible, report this explicit non-blocking result:

   ```text
   Graphify status: unavailable or incompatible — skipped. Continuing with direct source and test evidence; no install, update, or fallback was attempted.
   ```

   Then stop Graphify work and continue the normal direct-source workflow.

## Strict command allowlist

After a successful preflight, use only the smallest command needed for the recorded question. Beyond the non-mutating preflight help commands above, these are the only Graphify commands allowed by this skill:

```bash
graphify extract . --code-only --no-cluster --max-workers 8
graphify cluster-only . --no-viz --no-label
graphify god-nodes --top 15
graphify affected <symbol> --depth 2
graphify path "<source-symbol>" "<target-symbol>"
GRAPHIFY_QUERY_LOG_DISABLE=1 graphify query "<concrete structural question>" --budget 800
graphify update .
```

Rules for that allowlist:

- Use extraction only to create AST-only evidence; never combine it with clustering.
- Run `cluster-only` only when clustering is necessary to answer the opted-in question; it must retain `--no-viz --no-label`.
- Use `god-nodes` only with `--top 15`, `affected` only with `--depth 2`, and at most one `path` command with the two recorded symbols.
- Run at most one bounded query for the recorded concrete question, always with `GRAPHIFY_QUERY_LOG_DISABLE=1` and budget `800`. Do not log, persist, or replay queries.
- `graphify update .` is permitted only when Graphify was already opted in **and** source files changed after the prior graph evidence. Never use it to start an ordinary workflow or when no source changed.
- Do not add flags, paths, commands, loops, retries, or broad follow-up analysis beyond this allowlist. If the answer remains unclear, mark it ambiguous and inspect source/tests instead.

## Evidence and verification

Preserve the provenance of every statement; never upgrade a label without new direct evidence:

- **EXTRACTED** — a direct, bounded AST result from an allowed command.
- **INFERRED** — a conclusion drawn from one or more extracted results.
- **AMBIGUOUS** — incomplete, dynamic, generated, reflective, or otherwise unresolved structure.

Verify every **INFERRED** and **AMBIGUOUS** statement against the relevant source and tests before using it in a plan, implementation decision, review finding, or recommendation. If source/tests disagree with Graphify, source/tests win and the packet must say so. EXTRACTED evidence is still structural only; it does not prove runtime behavior.

Return one compact evidence packet; do not paste raw graph output:

```markdown
### Graphify structural evidence
- **Status:** used | unavailable | incompatible | not requested
- **Question:** <one concrete question, symbol, or path>
- **Commands:** <exact allowlisted commands run, or none>
- **Bounds:** AST-only; code-only; max workers 8; <applicable depth/top/path/query budget>; no query log
- **Claims:**
  - **EXTRACTED:** <fact>
  - **INFERRED:** <claim> — source/test verification: <result>
  - **AMBIGUOUS:** <uncertainty> — source/test verification: <result>
- **Confidence:** <high | medium | low and why>
- **Limitations:** <staleness, dynamic dispatch, generated code, missing CLI, or other gap>
```

Omit claim categories that have no evidence, but always include status, commands, bounds, confidence, and limitations. For unavailable or incompatible preflight, use `Commands: none` and explicitly state direct-source continuation.
