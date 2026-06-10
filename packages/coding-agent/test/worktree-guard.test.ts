import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _extractBranchTarget, clearWorktreeCache, isWorktreeConflictCommand } from "../src/core/worktree-guard.js";

describe("_extractBranchTarget", () => {
	it("extracts branch from git checkout", () => {
		expect(_extractBranchTarget("git checkout main")).toBe("main");
	});

	it("extracts branch with slashes and dashes", () => {
		expect(_extractBranchTarget("git checkout feature/foo-bar")).toBe("feature/foo-bar");
	});

	it("returns undefined for file checkout", () => {
		expect(_extractBranchTarget("git checkout -- file.txt")).toBeUndefined();
	});

	it("returns undefined for git checkout -b (create branch)", () => {
		expect(_extractBranchTarget("git checkout -b new-branch")).toBeUndefined();
	});

	it("extracts branch from git switch", () => {
		expect(_extractBranchTarget("git switch develop")).toBe("develop");
	});

	it("returns undefined for git switch -c (create branch)", () => {
		expect(_extractBranchTarget("git switch -c new-branch")).toBeUndefined();
	});

	it("returns marker for gh pr checkout", () => {
		expect(_extractBranchTarget("gh pr checkout 42")).toBe("__gh_pr_checkout__");
	});

	it("returns undefined for non-git commands", () => {
		expect(_extractBranchTarget("echo hello")).toBeUndefined();
	});
});

describe("isWorktreeConflictCommand", () => {
	let repoDir: string;
	let worktreeDir: string;
	const worktreeBranch = "feature/in-worktree";

	beforeEach(() => {
		clearWorktreeCache();
		repoDir = mkdtempSync(path.join(tmpdir(), "wt-guard-repo-"));
		// Remove GIT_* env vars inherited from git hooks (pre-commit sets GIT_DIR, GIT_INDEX_FILE)
		// that would cause git to use the wrong repo.
		const { GIT_DIR: _, GIT_INDEX_FILE: __, GIT_WORK_TREE: ___, ...cleanEnv } = process.env;
		const run = (cmd: string) => execSync(cmd, { cwd: repoDir, encoding: "utf-8", env: cleanEnv });
		run("git init -q");
		run("git config user.email test@test.com");
		run("git config user.name test");
		run("git config commit.gpgsign false");
		writeFileSync(path.join(repoDir, "README.md"), "hello\n");
		run("git add README.md");
		run("git commit -q -m init");
		// Create another local branch (no worktree)
		run("git branch other-branch");
		// Create a worktree on a new branch
		worktreeDir = `${repoDir}-wt`;
		run(`git worktree add -b ${worktreeBranch} "${worktreeDir}"`);
	});

	afterEach(() => {
		clearWorktreeCache();
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(worktreeDir, { recursive: true, force: true });
	});

	it("blocks checkout of a branch with an active worktree", () => {
		const result = isWorktreeConflictCommand(`git checkout ${worktreeBranch}`, repoDir);
		expect(result.blocked).toBe(true);
		expect(result.worktreePath).toBeDefined();
		expect(result.reason).toContain(worktreeBranch);
	});

	it("does not block checkout of a branch without a worktree", () => {
		const result = isWorktreeConflictCommand("git checkout other-branch", repoDir);
		expect(result.blocked).toBe(false);
	});

	it("does not block file checkout", () => {
		const result = isWorktreeConflictCommand("git checkout -- file.txt", repoDir);
		expect(result.blocked).toBe(false);
	});

	it("blocks gh pr checkout when worktrees exist", () => {
		const result = isWorktreeConflictCommand("gh pr checkout 42", repoDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("gh pr checkout");
	});

	it("passes through non-git commands", () => {
		const result = isWorktreeConflictCommand("echo hello", repoDir);
		expect(result.blocked).toBe(false);
	});
});

describe("clearWorktreeCache", () => {
	it("does not throw", () => {
		expect(() => clearWorktreeCache()).not.toThrow();
	});
});
