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
export function versionServiceWorker(swPath: string = swOut): Plugin {
	return {
		name: "dreb-version-service-worker",
		apply: "build",
		writeBundle: {
			sequential: true,
			handler() {
				let before: string;
				try {
					before = readFileSync(swPath, "utf-8");
				} catch {
					// This handler only runs during `apply: "build"`, so a missing
					// sw.js at this point means the build is misconfigured (public/sw.js
					// deleted or the public-dir copy failed). Fail loudly so `npm run
					// build` errors out and CI catches it — otherwise the emitted sw.js
					// keeps the literal `__SW_VERSION__` placeholder and the SW cache
					// never advances across deploys.
					throw new Error(
						"dreb versionServiceWorker: dist/static/sw.js missing after build — public/sw.js may have been deleted or the public-dir copy failed",
					);
				}
				if (!before.includes("__SW_VERSION__")) return; // already versioned
				writeFileSync(swPath, before.replace("__SW_VERSION__", String(dashboardVersion)));
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