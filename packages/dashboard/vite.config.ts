import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "package.json");
const dashboardVersion = JSON.parse(readFileSync(pkgRoot, "utf-8")).version ?? "0.0.0";
const swOut = resolve(dirname(fileURLToPath(import.meta.url)), "dist/static/sw.js");

/**
 * Version the service worker at build time.
 *
 * `public/sw.js` ships with a `__SW_VERSION__` placeholder. This plugin rewrites
 * it to the dashboard package version in the emitted bundle so a new deploy
 * produces a new SW cache name (`dreb-dashboard-shell-v<version>`). The old
 * service worker's `activate` handler then drops prior caches and
 * `clients.claim()` takes over — no stale client against a newer server API.
 *
 * The SW file itself keeps a STABLE URL (never content-hashed) so browsers can
 * fetch the latest copy and compare byte-for-byte on every load. Public-dir
 * assets are emitted by Vite's built-in copy step, so we patch the file in
 * `writeBundle` once it's on disk.
 */
function versionServiceWorker(): Plugin {
	return {
		name: "dreb-version-service-worker",
		apply: "build",
		writeBundle: {
			sequential: true,
			handler() {
				let before: string;
				try {
					before = readFileSync(swOut, "utf-8");
				} catch {
					return; // sw.js not present (test/no-public build) — no-op.
				}
				if (!before.includes("__SW_VERSION__")) return; // already versioned
				writeFileSync(swOut, before.replace("__SW_VERSION__", String(dashboardVersion)));
				console.log(`service worker versioned: sw.js → v${dashboardVersion}`); // eslint-disable-line no-console
			},
		},
	};
}

// Builds the browser client into dist/static, served by the dashboard server.
export default defineConfig({
	plugins: [solid(), versionServiceWorker()],
	root: resolve(import.meta.dirname, "src/client"),
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "dist/static"),
		emptyOutDir: true,
	},
});