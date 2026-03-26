# Spec: Glob Tool

## Overview

Pattern-based file search. Takes a glob pattern (e.g. `**/*.ts`, `src/components/**/*.tsx`) and returns matching file paths. Used heavily by subagents (298 calls) for codebase exploration.

## Tool definition

```
Name: glob
Description: Find files matching a glob pattern. Returns file paths sorted by
             modification time (newest first). Use for finding files by name
             or extension patterns.

Parameters:
  pattern:  string (required)  # Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")
  path:     string (optional)  # Directory to search in. Defaults to cwd.
```

## Behavior

```
Pseudocode:

MAX_RESULTS = 100

function glob(pattern, path=null):
    search_dir = path or session.cwd

    # Validate search directory exists
    if not is_directory(search_dir):
        return error(f"Directory does not exist: {search_dir}")

    # Execute glob match
    matches = glob_match(pattern, {
        cwd: search_dir,
        dot: true,          # include hidden files (dotfiles)
        nodir: true,        # only files, not directories
        follow: true,       # follow symlinks
    })

    # Stat each file for mtime (parallel, tolerate errors)
    file_stats = await parallel_stat(matches)

    # Sort by mtime descending (newest first), filename as tiebreaker
    sorted_files = sort(file_stats, key=lambda f: (-f.mtime_ms, f.path))

    # Apply result limit
    truncated = len(sorted_files) > MAX_RESULTS
    results = sorted_files[:MAX_RESULTS]

    # Format output
    output = "\n".join(f.path for f in results)
    if truncated:
        output += f"\n\n(Results truncated to {MAX_RESULTS}. Use a more specific path or pattern.)"
    if not results:
        output = "No files found"

    return {
        "filenames": [f.path for f in results],
        "num_files": len(results),
        "truncated": truncated,
    }
```

## Glob pattern syntax

Standard glob patterns:
- `*` — match any characters except path separator
- `**` — match any characters including path separator (recursive)
- `?` — match single character
- `[abc]` — character class
- `{ts,tsx}` — brace expansion (match any alternative)

Examples:
- `**/*.ts` — all TypeScript files recursively
- `src/components/**/*.tsx` — all TSX files under src/components
- `*.{js,ts}` — JS and TS files in current directory
- `.env*` — all dotenv files

## Properties

- **Read-only:** no filesystem modifications
- **Concurrency-safe:** multiple glob calls can run in parallel
- **Available in subagents:** primary exploration tool for Explore agents

## Relationship to pi-mono's find tool

Pi-mono ships a `find` tool that takes a name or path argument. Glob is a superset — it can express everything `find` can plus brace expansion and recursive wildcards. In dreb, we enable glob and keep find available as an alias or for users who prefer the find mental model.

## Implementation notes

In Node.js, use the `glob` or `fast-glob` npm package. The key requirements are:
- Brace expansion support
- `**` recursive matching
- Dotfile inclusion (opt-in, enabled by default)
- Symlink following
- Reasonable performance on large codebases (fast-glob uses filesystem streaming)

The mtime sort requires a `stat()` call per matched file. For large result sets this could be slow — the 100-file cap keeps it bounded. Use `Promise.allSettled` for the parallel stat calls so individual permission errors don't fail the whole operation.
