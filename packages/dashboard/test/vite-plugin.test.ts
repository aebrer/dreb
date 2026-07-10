/**
 * Unit tests for the `versionServiceWorker` Vite plugin in `vite.config.ts`.
 *
 * The plugin's `writeBundle` handler rewrites the `__SW_VERSION__` placeholder
 * in the emitted `dist/static/sw.js` to the dashboard package version so each
 * deploy gets a fresh service-worker cache name. These tests guard three
 * behaviors:
 *
 * 1. The placeholder is replaced with the dashboard package version.
 * 2. Patching is idempotent — an already-versioned sw.js is left untouched.
 * 3. A missing sw.js throws loudly (regression guard for the silent-UI-drift
 *    bug where a missing sw.js used to make the handler return silently,
 *    leaving the literal `__SW_VERSION__` placeholder in the emitted file).
 *
 * The plugin factory was refactored to accept an optional `swPath` arg
 * (defaulting to the production `dist/static/sw.js` path) so tests can point
 * it at real temp files instead of mocking `node:fs`.
 */

// Pull the dashboard package version the same way the plugin does (module-level
// read of `package.json`), so the assertion stays in sync with the source of
// truth without hardcoding a number that drifts across releases.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versionServiceWorker } from "../vite.config.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
const dashboardVersion = JSON.parse(readFileSync(pkgPath, "utf-8")).version;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempSw(initial: string): Promise<{ dir: string; swPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-sw-"));
	tempDirs.push(dir);
	const swPath = join(dir, "sw.js");
	await writeFile(swPath, initial, "utf-8");
	return { dir, swPath };
}

function callWriteBundle(plugin: ReturnType<typeof versionServiceWorker>): void {
	const hook = plugin.writeBundle;
	if (typeof hook !== "object" || hook === null || typeof hook.handler !== "function") {
		throw new Error("expected writeBundle hook object with sequential + handler");
	}
	// The plugin declares `sequential: true`; assert that contract holds.
	expect(hook.sequential).toBe(true);
	// The handler implementation reads no args/this; invoke as a no-arg fn.
	void (hook.handler as () => void)();
}

describe("versionServiceWorker writeBundle handler", () => {
	it("replaces __SW_VERSION__ with the dashboard package version", async () => {
		const { swPath } = await makeTempSw('const V = "__SW_VERSION__";');
		callWriteBundle(versionServiceWorker(swPath));

		const after = await readFile(swPath, "utf-8");
		expect(after).not.toContain("__SW_VERSION__");
		expect(after).toContain(String(dashboardVersion));
		expect(after).toBe(`const V = "${dashboardVersion}";`);
	});

	it("is idempotent — leaves an already-versioned sw.js unchanged", async () => {
		const original = 'const V = "2.35.0";';
		const { swPath } = await makeTempSw(original);
		callWriteBundle(versionServiceWorker(swPath));

		const after = await readFile(swPath, "utf-8");
		expect(after).toBe(original);
		expect(after).not.toContain("__SW_VERSION__");
	});

	it("throws loudly when sw.js is missing (no silent UI drift)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dreb-sw-missing-"));
		tempDirs.push(dir);
		const missing = join(dir, "does-not-exist.js");

		expect(() => callWriteBundle(versionServiceWorker(missing))).toThrowError(
			/dist\/static\/sw\.js missing after build/i,
		);
	});

	it("uses the production dist/static/sw.js path by default (no swPath arg)", () => {
		// Sanity check: the factory with no arg must still build a valid plugin
		// whose handler targets the real emission path. We don't run the handler
		// here (dist may not exist in a test-only checkout); we just verify the
		// plugin shape and that it doesn't throw at construction time.
		const plugin = versionServiceWorker();
		expect(plugin.name).toBe("dreb-version-service-worker");
		expect(plugin.apply).toBe("build");
		expect(typeof plugin.writeBundle).toBe("object");
	});

	beforeEach(() => {
		// ensure no state leaks between tests; temp dirs cleaned in afterEach
	});
});
