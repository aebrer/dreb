/**
 * Root Vitest configuration.
 *
 * Defines which packages participate in the vitest workspace, so that running
 * vitest from the repo root (including path-filtered runs like
 * `npx vitest --run packages/dashboard`) respects each package's own
 * vitest.config.ts.
 *
 * The `packages/tui` package is excluded because it uses node:test, not vitest.
 * Running vitest against its test files produces "No test suite found in file"
 * failures (see issue #89).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			"packages/ai",
			"packages/agent",
			"packages/coding-agent",
			"packages/semantic-search",
			"packages/telegram",
			"packages/dashboard",
		],
	},
});
