#!/usr/bin/env bash
set -e

# Skip local LLM tests (ollama, lmstudio) — no local server expected in CI/hooks
export DREB_NO_LOCAL_LLM=1

# Provider E2E tests run for any provider with a configured API key.
# Tests for unconfigured providers are skipped automatically.

LOG_FILE="/tmp/dreb-test-$(date +%s).log"

echo "Running tests..."
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
