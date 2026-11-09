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
describe("find tool — path-based glob patterns", () => {
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

	async function runFind(pattern: string): Promise<string[]> {
		const find = createFindTool(root);
		const result = await find.execute("find-path-glob", { pattern });
		const text = (result.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => ("text" in block ? block.text : ""))
			.join("\n");
		expect(text).not.toMatch(/\[fd error\]/i);
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
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
});
