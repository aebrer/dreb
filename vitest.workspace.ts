/**
 * Vitest workspace configuration.
 *
 * Defines which packages participate in the vitest workspace, so that running
 * vitest from the repo root respects each package's own vitest.config.ts.
 *
 * The `packages/tui` package is excluded because it uses node:test, not vitest.
 * Running vitest against its test files produces "No test suite found in file"
 * failures (see issue #89).
 */
import { defineWorkspace } from "vitest/config";

export default defineWorkspace(["packages/ai", "packages/agent", "packages/coding-agent", "packages/telegram"]);
