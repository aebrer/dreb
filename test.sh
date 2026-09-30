#!/usr/bin/env bash
set -e

# When invoked from a git hook (e.g. husky pre-commit), git exports repo-location
# variables (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, …) into the environment.
# These leak into tests that shell out to `git` in throwaway temp repos
# (git-update.test.ts, tools.test.ts's .gitignore cases, …), redirecting their
# `git init`/`clone`/`commit` at the parent repo and making them fail — even
# though the same tests pass when run standalone. Unset the location-pinning
# vars so subprocess git operations resolve against their own cwd. Identity
# vars (GIT_AUTHOR_*/GIT_COMMITTER_*) are intentionally left intact.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR \
    GIT_NAMESPACE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

# Skip local LLM tests (ollama, lmstudio) — no local server expected in CI/hooks
export DREB_NO_LOCAL_LLM=1

# Live provider API tests are OPT-IN. They make real, billed requests using API keys
# and subscription OAuth logins (~/.dreb/agent/auth.json), so by default every
# live-API test block skips. Pass --live-api to set DREB_LIVE_API=1 and run them.
# The largest requests (context-overflow tests that send more than a full context
# window) additionally need DREB_LIVE_API_EXPENSIVE=1 in the environment.
LIVE_API=false
for arg in "$@"; do
    case "$arg" in
        --live-api) LIVE_API=true ;;
        *) echo "Unknown argument: $arg (supported: --live-api)" >&2; exit 2 ;;
    esac
done

LOG_FILE="/tmp/dreb-test-$(date +%s).log"

# Never inherit an opt-in from the calling shell unless --live-api was passed.
if [ "$LIVE_API" = true ]; then
    echo "Running tests (LIVE provider API tests enabled via DREB_LIVE_API=1 — this spends real quota)..."
    export DREB_LIVE_API=1
else
    echo "Running tests (live provider API tests skipped; pass --live-api to enable)..."
    unset DREB_LIVE_API DREB_LIVE_API_EXPENSIVE
fi

# NO_COLOR prevents vitest/chalk from emitting ANSI codes when CI=true forces
# color output even through pipes — without this, grep patterns can't match.
if NO_COLOR=1 npm test > "$LOG_FILE" 2>&1; then
    # Aggregate results across all test runners (vitest + node:test)
    # Vitest lines have leading whitespace: "      Tests  N passed | M skipped (T)"
    # Node test runner lines: "# tests N", "# pass N", "# fail N"
    # Use awk instead of grep -P for macOS compatibility (BSD grep lacks -P)
    VITEST_PASSED=$(awk '/Tests[[:space:]]+[0-9]+[[:space:]]+passed/ { for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/ && $(i+1) == "passed") s+=$i } END {print s+0}' "$LOG_FILE")
    # Vitest format: "Tests  N failed | M passed" — "N failed" comes before "passed"
    VITEST_FAILED=$(awk '/Tests[[:space:]]+[0-9]+[[:space:]]+failed/ { for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/ && $(i+1) == "failed") s+=$i } END {print s+0}' "$LOG_FILE")
    VITEST_SKIPPED=$(awk '/\|[[:space:]]+[0-9]+[[:space:]]+skipped/ { for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/ && $(i+1) == "skipped") s+=$i } END {print s+0}' "$LOG_FILE")
    # Node v24: "# pass N" / "# fail N" — Node v25: "ℹ pass N" / "ℹ fail N"
    NODE_PASSED=$(awk '/^[[:space:]]*(#|ℹ)[[:space:]]+pass[[:space:]]/ { for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/) s+=$i } END {print s+0}' "$LOG_FILE")
    NODE_FAILED=$(awk '/^[[:space:]]*(#|ℹ)[[:space:]]+fail[[:space:]]/ { for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/) s+=$i } END {print s+0}' "$LOG_FILE")

    TOTAL_PASSED=$((VITEST_PASSED + NODE_PASSED))
    TOTAL_FAILED=$((VITEST_FAILED + NODE_FAILED))

    # Guard: zero tests discovered means something is wrong (misconfigured runners, broken imports, etc.)
    if [ "$TOTAL_PASSED" -eq 0 ] && [ "$TOTAL_FAILED" -eq 0 ]; then
        echo "ERROR: Zero tests discovered. Possible runner misconfiguration."
        echo "  Full log: $LOG_FILE"
        exit 1
    fi

    echo "All tests passed."
    echo "  passed: $TOTAL_PASSED | failed: $TOTAL_FAILED | skipped: $VITEST_SKIPPED"
    echo "  Full log: $LOG_FILE"
else
    EXIT_CODE=$?
    echo ""
    echo "Tests failed! Showing failures:"
    echo "─────────────────────────────────"
    # Show failed test names and error details
    grep -E "(FAIL|not ok|✕|×|Error:|failed)" "$LOG_FILE" | head -30
    echo "─────────────────────────────────"
    echo ""
    # Show per-runner summaries
    grep -E '(Tests[[:space:]]+[0-9]+|# tests[[:space:]]+[0-9]+|# fail[[:space:]]+[0-9]+|Test Files)' "$LOG_FILE" | tail -10
    echo ""
    echo "Full log: $LOG_FILE"
    exit $EXIT_CODE
fi
