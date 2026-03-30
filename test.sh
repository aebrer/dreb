#!/usr/bin/env bash
set -e

# Skip local LLM tests (ollama, lmstudio) — no local server expected in CI/hooks
export DREB_NO_LOCAL_LLM=1

# Provider E2E tests run for any provider with a configured API key.
# Tests for unconfigured providers are skipped automatically.

LOG_FILE="/tmp/dreb-test-$(date +%s).log"

echo "Running tests..."
if npm test > "$LOG_FILE" 2>&1; then
    # Aggregate results across all test runners (vitest + node:test)
    # Vitest lines have leading whitespace: "      Tests  N passed | M skipped (T)"
    # Node test runner lines: "# tests N", "# pass N", "# fail N"
    VITEST_PASSED=$(grep -oP 'Tests\s+\K\d+(?=\s+passed)' "$LOG_FILE" | awk '{s+=$1} END {print s+0}')
    VITEST_FAILED=$(grep -oP 'Tests\s+\d+\s+failed\s+\|\s+\K\d+' "$LOG_FILE" | awk '{s+=$1} END {print s+0}')
    # Vitest "N failed" comes before "passed" — extract differently
    VITEST_FAILED=$(grep -oP 'Tests\s+\K\d+(?=\s+failed)' "$LOG_FILE" | awk '{s+=$1} END {print s+0}')
    VITEST_SKIPPED=$(grep -oP '\|\s+\K\d+(?=\s+skipped)' "$LOG_FILE" | awk '{s+=$1} END {print s+0}')
    NODE_PASSED=$(grep -P '^# pass ' "$LOG_FILE" | grep -oP '\d+' | awk '{s+=$1} END {print s+0}')
    NODE_FAILED=$(grep -P '^# fail ' "$LOG_FILE" | grep -oP '\d+' | awk '{s+=$1} END {print s+0}')

    TOTAL_PASSED=$((VITEST_PASSED + NODE_PASSED))
    TOTAL_FAILED=$((VITEST_FAILED + NODE_FAILED))

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
    grep -P '(Tests\s+\d+|# tests\s+\d+|# fail\s+\d+|Test Files)' "$LOG_FILE" | tail -10
    echo ""
    echo "Full log: $LOG_FILE"
    exit $EXIT_CODE
fi
