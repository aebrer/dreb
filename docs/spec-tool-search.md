# Spec: ToolSearch (Dynamic Tool Discovery)

## Overview

ToolSearch allows the agent to discover and activate tools on-demand rather than loading every tool schema into context at session start. This keeps the initial system prompt lean when the tool ecosystem grows large (custom extensions, MCP servers, project-specific tools).

## The problem

Every tool's schema (name, description, parameters) consumes context tokens. With 10 built-in tools, this is fine. With 30+ tools (built-ins + extensions + MCP + skills), it starts eating into useful context. ToolSearch solves this by:

1. **Eagerly loading** core tools (bash, read, edit, write, grep, glob, web_search, web_fetch, subagent, tasks_update, skill)
2. **Deferring** everything else — the agent only knows a tool exists by name, not its full schema
3. **Activating on demand** — when the agent needs a deferred tool, it calls ToolSearch to get the full schema, which then becomes available for the rest of the session

## Tool definition

```
Name: tool_search
Description: Search for and activate deferred tools. Returns full tool schemas
             that become available for use in this session.

Parameters:
  query:        string (required)   # Search query or exact tool name(s)
  max_results:  int    (optional)   # Max results to return (default: 5)
```

## Query syntax

Three query modes:

1. **Exact selection:** `"select:Read,Edit,Grep"` — fetch these exact tools by name
2. **Keyword search:** `"notebook jupyter"` — fuzzy match against tool names and descriptions
3. **Required prefix + keywords:** `"+slack send"` — require "slack" in the name, rank by remaining terms

## Matching algorithm

```
Pseudocode:

function tool_search(query, max_results=5):
    deferred_tools = get_deferred_tool_registry()
    always_loaded = get_loaded_tool_names()

    # Mode 1: Exact selection
    if query.startswith("select:"):
        names = query[7:].split(",")
        matches = []
        for name in names:
            tool = find_tool_by_name(name.strip(), deferred_tools + always_loaded)
            if tool:
                matches.append(tool)
        return activate_and_return(matches)

    # Parse query into required (+prefix) and optional terms
    terms = query.lower().split()
    required = [t[1:] for t in terms if t.startswith("+")]
    optional = [t for t in terms if not t.startswith("+")]

    # Score each deferred tool
    scored = []
    for tool in deferred_tools:
        score = 0
        name_parts = split_name(tool.name)  # camelCase → words, snake_case → words

        # Required terms must all match somewhere
        if required:
            all_match = all(
                any(req in part for part in name_parts + [tool.description.lower()])
                for req in required
            )
            if not all_match:
                continue

        # Score optional terms
        for term in optional:
            if term in name_parts:
                score += 10        # exact name part match
            elif any(term in part for part in name_parts):
                score += 5         # partial name match
            elif term in tool.description.lower():
                score += 2         # description match

        if score > 0 or (not optional and required):
            scored.append((tool, score))

    # Sort by score descending
    scored.sort(key=lambda x: -x[1])
    matches = [tool for tool, score in scored[:max_results]]

    return activate_and_return(matches)


function activate_and_return(tools):
    # Make these tools available for the rest of the session
    for tool in tools:
        session.activate_tool(tool)

    return {
        "matches": [{"name": t.name, "description": t.description} for t in tools],
        "total_deferred": len(get_deferred_tool_registry()),
    }
```

### Name splitting

Tool names are split into searchable parts:
- `camelCase` → `["camel", "case"]`
- `snake_case` → `["snake", "case"]`
- `mcp__server__tool` → `["server", "tool"]`

## Deferred tool registry

At session start, build a registry of all available tools:

```
Pseudocode:

function build_tool_registry():
    all_tools = discover_all_tools()  # built-ins + extensions + MCP

    eager = []   # always loaded (core tools)
    deferred = [] # available but not loaded

    for tool in all_tools:
        if tool.name in CORE_TOOLS:
            eager.append(tool)         # full schema in context
        else:
            deferred.append({
                "name": tool.name,
                "description": tool.description,  # just the one-liner
                # full parameter schema NOT loaded yet
            })

    return eager, deferred
```

The system prompt includes a list of deferred tool names so the agent knows what's available:

```
The following deferred tools are available via tool_search:
NotebookEdit, CronCreate, CronDelete, CronList, ...
```

## When tools get activated

Once ToolSearch returns a tool, its full schema (parameters, description) is available to the agent for the rest of the session. The agent can then call it like any other tool.

Activation is session-scoped — deferred tools reset on session restart.

## Implementation notes

- **Core tools list** is configurable in dreb settings, but defaults to the tools with highest usage from our analysis
- **MCP server tools** are always deferred (prefixed with `mcp__`)
- **Extension tools** are deferred by default unless the extension marks them as core
- The registry should cache tool descriptions to avoid re-scanning the filesystem on every ToolSearch call
- Invalidate cache when the deferred tool list changes (e.g. MCP server connects mid-session)
