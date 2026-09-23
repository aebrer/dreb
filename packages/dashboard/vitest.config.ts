import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Client screen tests opt into jsdom with a per-file `// @vitest-environment jsdom`
// docblock; server/reducer tests run in the default node environment.
export default defineConfig({
	plugins: [solid()],
	test: {
		globals: true,
		environment: "node",
		testTimeout: 10000,
		// Real-browser source fixtures start Chromium and independent Vite servers.
		// Serialize files so those mobile acceptance paths measure the app instead
		// of starving each other during transform and browser startup.
		fileParallelism: false,
		sequence: { groupOrder: 1 },
	},
	resolve: {
		conditions: ["development", "browser"],
		alias: [{ find: /^solid-js\/web$/, replacement: "solid-js/web/dist/web.js" }],
	},
});
