import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
