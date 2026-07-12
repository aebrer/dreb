import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "../src/config.js";

describe("getPackageDir", () => {
	it("returns the package root (contains agents/ directory)", () => {
		const packageDir = getPackageDir();
		// Must be a real directory
		expect(existsSync(packageDir), `package dir does not exist: ${packageDir}`).toBe(true);
		expect(statSync(packageDir).isDirectory(), `not a directory: ${packageDir}`).toBe(true);
		// Must have package.json
		expect(existsSync(join(packageDir, "package.json")), `no package.json at: ${packageDir}`).toBe(true);
		// agents/ must exist — it's relied on as a package-root marker and is shipped in the files array.
		// If someone removes agents/ from files or deletes the directory, this test fails loudly.
		expect(
			existsSync(join(packageDir, "agents")),
			`agents/ directory missing from package root: ${packageDir}. Is it in the 'files' array in package.json?`,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Mocked-filesystem tests for the marker heuristic and candidate fallback.
//
// getPackageDir() derives __dirname at module load from
// `dirname(fileURLToPath(import.meta.url))` and walks up looking for
// package.json. To exercise the heuristic deterministically we mock node:url
// (to pin __dirname) and node:fs (to control which paths "exist"), then
// re-import the module under those mocks via vi.resetModules() + import().
//
// The happy-path test above is intentionally left using the real filesystem
// — its static import binding is captured before any doMock runs, so the
// mocks below never affect it.
// ---------------------------------------------------------------------------
describe("getPackageDir (mocked filesystem)", () => {
	afterEach(() => {
		vi.doUnmock("node:url");
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("skips a stale dist/package.json (no markers) and returns the real package root", async () => {
		// __dirname -> /fake/pkg/dist (a stale build output with a copied package.json)
		vi.resetModules();
		vi.doMock("node:url", () => ({
			fileURLToPath: () => "/fake/pkg/dist/config.js",
		}));
		vi.doMock("node:fs", () => ({
			// /fake/pkg/dist has package.json but NO src/node_modules/agents.
			// /fake/pkg has package.json AND agents/ (the package-root marker).
			existsSync: (p: string) =>
				p === "/fake/pkg/dist/package.json" || p === "/fake/pkg/package.json" || p === "/fake/pkg/agents",
			readFileSync: () => '{"version":"0.0.0","drebConfig":{}}',
		}));

		const { getPackageDir: getPackageDirMocked } = await import("../src/config.js");
		expect(getPackageDirMocked()).toBe("/fake/pkg");
	});

	it("falls back to the last package.json-containing directory when no markers are found", async () => {
		// __dirname -> /fake/pkg/dist; every package.json dir lacks markers, so
		// the walk exhausts and returns the last candidate (the highest dir with
		// a package.json, which is /fake/pkg).
		vi.resetModules();
		vi.doMock("node:url", () => ({
			fileURLToPath: () => "/fake/pkg/dist/config.js",
		}));
		vi.doMock("node:fs", () => ({
			// Two package.json dirs, neither has src/node_modules/agents.
			existsSync: (p: string) => p === "/fake/pkg/dist/package.json" || p === "/fake/pkg/package.json",
			readFileSync: () => '{"version":"0.0.0","drebConfig":{}}',
		}));

		const { getPackageDir: getPackageDirMocked } = await import("../src/config.js");
		expect(getPackageDirMocked()).toBe("/fake/pkg");
	});
});
