import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChdirToolDefinition } from "../src/core/tools/chdir.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content?.[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe("chdir tool", () => {
	let gitRepo: string;
	let nonGitDir: string;

	beforeEach(() => {
		// Create a temp dir that is a git repo (realpath to resolve macOS /var -> /private/var symlinks)
		gitRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "chdir-git-")));
		execSync("git init", { cwd: gitRepo, stdio: "ignore" });

		// Create a temp dir that is NOT a git repo
		nonGitDir = realpathSync(mkdtempSync(path.join(tmpdir(), "chdir-nogit-")));
	});

	afterEach(() => {
		rmSync(gitRepo, { recursive: true, force: true });
		rmSync(nonGitDir, { recursive: true, force: true });
	});

	it("changes to a valid git directory (happy path)", async () => {
		const def = createChdirToolDefinition(gitRepo);
		const result = await def.execute("id", { path: gitRepo }, undefined, undefined, undefined as any);
		const text = getText(result as any);
		expect(text).toContain("Changed working directory:");
		expect(text).toContain(gitRepo);
	});

	it("returns error for a non-existent directory", async () => {
		const def = createChdirToolDefinition(gitRepo);
		const missing = path.join(gitRepo, "does-not-exist");
		const result = await def.execute("id", { path: missing }, undefined, undefined, undefined as any);
		const text = getText(result as any);
		expect(text).toContain("Error: Directory does not exist:");
		expect(text).toContain(missing);
	});

	it("returns error when path is a file, not a directory", async () => {
		const filePath = path.join(gitRepo, "file.txt");
		writeFileSync(filePath, "hello");
		const def = createChdirToolDefinition(gitRepo);
		const result = await def.execute("id", { path: filePath }, undefined, undefined, undefined as any);
		const text = getText(result as any);
		expect(text).toContain("Error: Path is not a directory:");
		expect(text).toContain(filePath);
	});

	it("returns error when directory is not inside a git repo", async () => {
		const def = createChdirToolDefinition(nonGitDir);
		const result = await def.execute("id", { path: nonGitDir }, undefined, undefined, undefined as any);
		const text = getText(result as any);
		expect(text).toContain("Error: Target is not inside a git repository:");
		expect(text).toContain(nonGitDir);
	});

	it("invokes onChdir callback with the resolved absolute path", async () => {
		const onChdir = vi.fn();
		const def = createChdirToolDefinition(gitRepo, { onChdir });
		await def.execute("id", { path: gitRepo }, undefined, undefined, undefined as any);
		expect(onChdir).toHaveBeenCalledTimes(1);
		expect(onChdir).toHaveBeenCalledWith(gitRepo);
	});

	it("does not invoke onChdir when validation fails", async () => {
		const onChdir = vi.fn();
		const def = createChdirToolDefinition(gitRepo, { onChdir });
		await def.execute("id", { path: path.join(gitRepo, "does-not-exist") }, undefined, undefined, undefined as any);
		expect(onChdir).not.toHaveBeenCalled();
	});

	it("resolves a relative path against the cwd", async () => {
		const subdir = path.join(gitRepo, "sub");
		mkdirSync(subdir);
		const onChdir = vi.fn();
		const def = createChdirToolDefinition(gitRepo, { onChdir });
		const result = await def.execute("id", { path: "sub" }, undefined, undefined, undefined as any);
		const text = getText(result as any);
		expect(text).toContain("Changed working directory:");
		expect(text).toContain(subdir);
		expect(onChdir).toHaveBeenCalledWith(subdir);
	});
});
