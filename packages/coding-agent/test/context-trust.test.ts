import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeTrustedRoots, matchContextTrust } from "../src/core/context-trust.js";

const denyByDefault = { unrestricted: false, trustedFolders: [] };

describe("context trust", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dreb-context-trust-")));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("never interprets empty or relative configured roots against the process cwd", () => {
		const currentProject = realpathSync(process.cwd());
		const policy = {
			...denyByDefault,
			trustedFolders: ["", ".", "./", "relative-folder", "./relative-folder", ".."],
		};

		expect(matchContextTrust(policy, currentProject)).toBeNull();
	});

	it("returns only effective canonical roots, excluding invalid and nested duplicates", () => {
		const parent = join(tempDir, "parent");
		const child = join(parent, "child");
		mkdirSync(child, { recursive: true });
		const canonicalParent = realpathSync(parent);

		expect(
			canonicalizeTrustedRoots(["", ".", join(tempDir, "missing"), child, canonicalParent, child, canonicalParent]),
		).toEqual([canonicalParent]);
	});

	it("expands settings-style home roots before enforcing trust", () => {
		const canonicalHome = realpathSync(homedir());

		expect(canonicalizeTrustedRoots(["~", "~/"])).toEqual([canonicalHome]);
		expect(matchContextTrust({ ...denyByDefault, trustedFolders: ["~"] }, canonicalHome)).toEqual({
			targetDir: canonicalHome,
			trustedRoot: canonicalHome,
		});
	});
});
