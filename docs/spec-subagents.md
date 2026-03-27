# Spec: Subagent Orchestration

## Overview

The subagent system allows the main agent session to delegate work to independent child sessions. Each subagent runs in its own process with its own context window, executes a task, and returns results to the parent.

## Architecture

### Process model

Each subagent is a **separate OS process** — a new `dreb` invocation running in non-interactive (JSON/RPC) mode. This gives natural isolation: separate context windows, separate memory, crash isolation, and the ability to constrain tools per subagent.

```
Parent session (interactive)
  │
  ├─ spawn ──→ Subagent A (dreb --mode json --no-session -p "task...")
  │              └─ runs to completion, streams JSONL events on stdout
  │              └─ parent collects final messages + exit code
  │
  ├─ spawn ──→ Subagent B (concurrent)
  │
  └─ waits for results, incorporates into own context
```

### Why process-based, not in-process

- **Crash isolation:** a subagent hitting an error or running out of context doesn't take down the parent
- **Natural tool isolation:** pass `--tools read,grep,glob` to create a read-only researcher
- **Model flexibility:** subagent can use a different/cheaper model than parent
- **No shared state bugs:** each process has its own session state

## Tool definition

```
Name: subagent
Description: Delegate tasks to specialized subagents that run independently.

Parameters:
  # --- Single mode (one subagent) ---
  agent:        string (optional)  # Agent type name (e.g. "Explore", "code-reviewer")
  task:         string (required in single mode)  # The task prompt
  cwd:          string (optional)  # Working directory, defaults to parent's cwd
  model:        string (optional)  # Model override (e.g. "haiku", "opus")

  # --- Parallel mode (multiple subagents) ---
  tasks:        array (optional)   # Array of {agent, task, cwd, model} objects
                                   # Max 8 tasks, run with concurrency limit of 4

  # --- Chain mode (sequential pipeline) ---
  chain:        array (optional)   # Array of {agent, task, model} objects
                                   # Each step can reference {previous} for prior output
                                   # Stops on first error

Modes are mutually exclusive: provide task (single), tasks (parallel), or chain.

Model precedence: per-invocation model > agent definition model > inherited from parent.
```

## Execution modes

### Single mode
Spawn one subagent, wait for completion, return result.

```
Pseudocode:

function execute_single(agent_name, task, cwd, model_override=None):
    agent_config = load_agent_config(agent_name)  # from ~/.dreb/agents/ or .dreb/agents/

    # Per-invocation model takes precedence over agent definition model
    effective_model = model_override or agent_config.model

    args = ["--mode", "json", "--no-session"]
    if effective_model:
        args += ["--model", effective_model]
    if agent_config.tools:
        args += ["--tools", agent_config.tools]
    if agent_config.system_prompt:
        tmpfile = write_temp_file(agent_config.system_prompt, mode=0o600)
        args += ["--append-system-prompt", tmpfile]
    args += ["-p", task]

    process = spawn("dreb", args, cwd=cwd, stdio=[ignore, pipe, pipe])
    messages = []

    for line in process.stdout:
        event = parse_json(line)
        if event.type == "message_end":
            messages.append(event.message)
        on_progress_update(event)  # stream progress to parent's UI

    stderr = drain(process.stderr)  # drain concurrently to avoid pipe deadlock
    exit_code = process.wait()

    cleanup(tmpfile)

    return {
        agent: agent_name,
        task: task,
        exit_code: exit_code,
        messages: messages,
        stderr: stderr,
    }
```

### Parallel mode
Run up to 8 tasks with max 4 concurrent processes.

```
Pseudocode:

function execute_parallel(task_list):
    assert len(task_list) <= 8

    semaphore = Semaphore(4)  # max concurrency
    results = []

    async for each task_item in task_list:
        semaphore.acquire()
        result = await execute_single(task_item.agent, task_item.task, task_item.cwd)
        results.append(result)
        semaphore.release()
        on_progress_update(f"{len(results)}/{len(task_list)} complete")

    return results
```

### Chain mode
Sequential pipeline where each step can reference the previous step's output.

```
Pseudocode:

function execute_chain(chain_steps):
    previous_output = ""
    results = []

    for step in chain_steps:
        task = step.task.replace("{previous}", previous_output)
        result = execute_single(step.agent, task, step.cwd)

        if result.exit_code != 0:
            results.append(result)
            break  # stop chain on error

        previous_output = extract_final_text(result.messages)
        results.append(result)

    return results
```

## Agent type system

### Discovery

Agent types are markdown files with YAML frontmatter, discovered from:
1. `~/.dreb/agents/*.md` — user-level (available everywhere)
2. `.dreb/agents/*.md` — project-level (repo-specific)

Project agents require user confirmation before first use (security gate — prevents untrusted repos from running arbitrary agent prompts).

### Agent definition format

```markdown
---
name: Explore
description: Fast codebase exploration — find files, search code, answer questions.
tools: read,grep,glob,bash
model: (optional, inherits parent if omitted)
---

You are a codebase exploration agent. Your job is to quickly find information
in the codebase and report back concisely.

Rules:
- Do NOT modify any files
- Be thorough but concise in your findings
- If you can't find what you're looking for, say so explicitly
```

### Built-in agent presets

These ship with dreb (not as files, but as defaults when no matching agent file is found):

**general-purpose** (default when no agent specified):
- All tools available
- Inherits parent's model
- No custom system prompt beyond the task itself

**Explore:**
- Tools: read, grep, glob, bash (read-only intent, bash for things like `git log`)
- System prompt emphasizes speed, conciseness, no file modification

## Result format

```
SingleResult:
    agent:         string        # agent type name
    task:          string        # original task prompt
    exit_code:     int           # 0 = success
    messages:      Message[]     # full conversation (assistant + tool results)
    stderr:        string        # captured stderr (for debugging)
    error_message: string | null # set if exit_code != 0
```

The parent session receives this as the tool result and can incorporate the subagent's findings into its own reasoning.

## Background execution

Subagents can optionally run in the background:
- Parent spawns the process and immediately returns a handle/ID to the user
- Parent continues processing other work
- When the subagent completes, the parent is notified (injected as a system event)
- Parent can then reference the results

```
Pseudocode:

function execute_background(agent_name, task, cwd):
    agent_id = generate_id()
    process = spawn_subagent(agent_name, task, cwd)

    register_completion_callback(agent_id, process, on_complete=lambda result:
        inject_system_event(f"Background agent {agent_id} completed: {summarize(result)}")
    )

    return f"Agent {agent_id} started in background. You'll be notified on completion."
```

## Limits and safety

- **Max parallel tasks:** 8
- **Max concurrency:** 4 processes at once
- **No explicit depth limit** for recursive spawning, but in practice context + process overhead provides natural limits
- **Process termination:** SIGTERM on abort, SIGKILL after 5 seconds if still running
- **No session persistence:** subagents run with `--no-session`, results only flow back via stdout
- **Project agent security:** `.dreb/agents/` files from untrusted repos require user confirmation

## Subagent JSONL event protocol

The subagent process emits one JSON object per line on stdout:

```
{"type": "message_start", "message": {...}}
{"type": "tool_use", "name": "read", "input": {...}}
{"type": "tool_result", "tool_use_id": "...", "content": [...]}
{"type": "message_end", "message": {...}, "usage": {...}}
```

The parent parses these for:
- **Progress display:** show what the subagent is doing in real-time
- **Message collection:** accumulate final messages for the result
- **Usage tracking:** aggregate token counts across subagents

## Continuing a subagent (SendMessage)

Not supported in initial implementation. Subagents are fire-and-forget: spawn with a task, collect results, done. If multi-turn interaction is needed, spawn a new subagent with the prior context included in the task prompt.

This is a deliberate simplification. Multi-turn subagent conversations add complexity (process lifetime management, state persistence) for marginal benefit — our usage data shows subagents are used for focused, single-task delegation.
