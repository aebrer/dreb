# Spec: Task / Progress Tracking

## Overview

Two levels of task tracking, serving different purposes:

1. **Session tasks (TodoWrite equivalent):** lightweight, session-local, for the agent to organize multi-step work and show progress to the user. This is the primary system — 356 calls in our usage data.

2. **Persistent tasks:** cross-session task tracking with dependencies. Low usage in our data (< 1% session penetration), but useful for multi-session projects and subagent coordination. Implement after session tasks are working.

## Session tasks

### Tool definition

```
Name: tasks_update
Description: Create or update the session task list. Send the complete current
             task list each time — this is a full replacement, not a patch.

Parameters:
  tasks:  array (required)  # Array of task objects:
    [
      {
        "id":          string,   # Stable identifier (e.g. "1", "setup", "fix-auth")
        "title":       string,   # Brief action-oriented title
        "status":      string,   # "pending" | "in_progress" | "completed"
      },
      ...
    ]
```

### Behavior

```
Pseudocode:

function tasks_update(tasks):
    # Validate: at most one task can be in_progress
    in_progress = [t for t in tasks if t.status == "in_progress"]
    if len(in_progress) > 1:
        return error("At most one task can be in_progress at a time")

    # Store in session state (in-memory, not persisted)
    session.task_list = tasks

    # Notify frontend to re-render
    emit_event("tasks_changed", tasks)

    return {"task_count": len(tasks), "completed": len([t for t in tasks if t.status == "completed"])}
```

### Frontend rendering

The task list is rendered differently per frontend:

**TUI:**
- Displayed in a dedicated status area (toggleable, e.g. Ctrl+T)
- Shows up to 10 tasks with status indicators:
  ```
  ☐ Set up test fixtures
  ⧖ Fix authentication handler
  ☑ Read existing test files
  ☑ Identify failing test case
  ```
- Completed tasks use dimmed text, in_progress is highlighted

**Telegram:**
- Rendered as a formatted message when the list changes significantly (not on every micro-update)
- Format:
  ```
  📋 Tasks:
  ⬜ Set up test fixtures
  🔄 Fix authentication handler
  ✅ Read existing test files
  ✅ Identify failing test case
  ```
- Only re-send when a task transitions to completed or a new task appears (avoid message spam)

**RPC/SDK:**
- Emit as structured JSON event: `{"type": "tasks_changed", "tasks": [...]}`
- Frontend decides how to render

### Lifecycle

- Tasks are created when the agent begins multi-step work
- Each time a task's status changes, the agent sends the full updated list
- Tasks are lost when the session ends (they are organizational, not archival)
- The system prompt should instruct the agent to use tasks for work requiring 3+ steps

### Why full-replacement instead of CRUD

Simpler to implement, harder to get into inconsistent state, and matches how the agent thinks about it — "here's my current plan" rather than "patch task #3 status to done". One tool call, one render, done.

## Persistent tasks (future)

For multi-session coordination (e.g. "finish the auth rewrite over several sessions"):

### Storage

```
~/.dreb/tasks/<list-id>/tasks.json
```

`list-id` is set via config or environment variable. Multiple sessions can share a task list.

### Additional fields beyond session tasks

```
{
  "id":          string,
  "title":       string,
  "description": string,      # Detailed requirements (loaded on-demand via task_get)
  "status":      string,      # "pending" | "in_progress" | "completed" | "deleted"
  "blocked_by":  string[],    # IDs of tasks that must complete first
  "blocks":      string[],    # IDs of tasks this blocks
  "owner":       string,      # Subagent or session that owns this task
  "metadata":    object,      # Arbitrary key-value pairs
}
```

### Tools

```
task_create(title, description, blocked_by?, blocks?)  →  task object
task_update(id, status?, title?, description?, ...)    →  updated task
task_get(id)                                           →  full task with description
task_list()                                            →  summary list (no descriptions)
```

### Dependency resolution

When a task completes, check if any tasks in its `blocks` list are now unblocked (all their `blocked_by` tasks are completed). If so, mark them as ready.

### Implementation priority

Session tasks first (P1). Persistent tasks later — the usage data shows minimal adoption of the cross-session Task* tools, so we should validate whether the simpler session tasks cover enough of the need before building the full system.
