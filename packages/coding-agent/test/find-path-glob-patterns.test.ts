import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindTool } from "../src/core/tools/find.js";

// The find tool advertises path-bearing glob patterns such as "src/**" + "/*.spec.ts",
// but the default fd-backed implementation matched patterns against the basename only,
// so those patterns silently returned nothing. fd 10.5 and newer reject a pattern
// containing "/" outright unless --full-path is given, which turns the same defect into
// a hard error. Ported from upstream pi-mono c5451af749 (their issue #3302).
describe.each([
	{ label: "native fd matching", windows: false },
	{ label: "Windows path matching", windows: true },
])("find tool — path-based glob patterns ($label)", ({ windows }) => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dreb-find-path-glob-"));
		mkdirSync(join(root, "src", "foo", "bar"), { recursive: true });
		mkdirSync(join(root, "some", "parent", "child"), { recursive: true });
		writeFileSync(join(root, "top.ts"), "export const top = true;\n");
		writeFileSync(join(root, "src", "example.spec.ts"), "");
		writeFileSync(join(root, "src", "foo", "bar", "nested.spec.ts"), "");
		writeFileSync(join(root, "some", "parent", "child", "deep.txt"), "");
		writeFileSync(join(root, "some", "parent", "direct.txt"), "");
		writeFileSync(join(root, "loose.txt"), "");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	async function runFind(pattern: string, options: { path?: string; limit?: number } = {}): Promise<string[]> {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			// Exercise the Windows branch with real fd traversal on every CI platform.
			// Native backslash candidates are also tested in find-windows-glob.test.ts.
			if (windows) Object.defineProperty(process, "platform", { value: "win32" });
			const find = createFindTool(root);
			const result = await find.execute("find-path-glob", { pattern, ...options });
			const text = (result.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n");
			expect(text).not.toMatch(/\[fd error\]/i);
			return text
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	}

	it("matches nested files for a ** glob", async () => {
		const results = await runFind("**/*.txt");
		expect(results).toContain(join("some", "parent", "child", "deep.txt").replace(/\\/g, "/"));
		expect(results).toContain("loose.txt");
	});

	it("matches files for a path-anchored glob", async () => {
		const results = await runFind("src/**/*.spec.ts");
		expect(results).toContain("src/example.spec.ts");
		expect(results).toContain("src/foo/bar/nested.spec.ts");
		expect(results).not.toContain("top.ts");
	});

	it("keeps * from crossing a directory boundary in a qualified glob", async () => {
		const results = await runFind("some/parent/*.txt");
		expect(results).toContain("some/parent/direct.txt");
		expect(results).not.toContain("some/parent/child/deep.txt");
	});

	it("keeps matching plain basename patterns", async () => {
		const results = await runFind("*.spec.ts");
		expect(results).toContain("src/example.spec.ts");
		expect(results).toContain("src/foo/bar/nested.spec.ts");
	});

	it("applies the limit after matching, not while enumerating nonmatches", async () => {
		const results = await runFind("some/parent/*.txt", { limit: 1 });
		expect(results[0]).toBe("some/parent/direct.txt");
		expect(results).toContainEqual(expect.stringContaining("1 results limit reached"));
	});

	it("preserves fd's gitignore enforcement for path globs", async () => {
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		writeFileSync(join(root, ".gitignore"), "src/foo/\n");
		expect(await runFind("src/**/*.spec.ts")).toEqual(["src/example.spec.ts"]);
	});

	it("keeps tool-visible memory paths but not ignored private directories", async () => {
		execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
		writeFileSync(join(root, ".gitignore"), ".dreb/\n");
		for (const directory of ["memory", "secrets"]) {
			mkdirSync(join(root, ".dreb", directory), { recursive: true });
			writeFileSync(join(root, ".dreb", directory, "entry.md"), "");
		}
		expect(await runFind("**/*.md")).toEqual([".dreb/memory/entry.md"]);
		expect(await runFind("**/*.md", { path: join(root, "src") })).toEqual(["No files found matching pattern"]);
	});
});
