import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, findWorktreeForBranch, getWorktreePath, listWorktrees } from "../src/core/worktree.js";

// Remove GIT_* env vars inherited from git hooks (pre-commit sets GIT_DIR, GIT_INDEX_FILE)
// that would cause git to use the wrong repo in our temp directories.
const { GIT_DIR: _, GIT_INDEX_FILE: __, GIT_WORK_TREE: ___, ...cleanEnv } = process.env;

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: cleanEnv });
}

function initRepo(cwd: string): void {
	git(cwd, "init -q");
	git(cwd, "config user.email test@example.com");
	git(cwd, "config user.name Test");
	git(cwd, "commit -q --allow-empty -m initial");
}

describe("worktree utilities", () => {
	let tempDir: string;
	let repoDir: string;

	beforeEach(() => {
		// realpathSync resolves macOS /var -> /private/var symlinks so path
		// comparisons against git output are stable.
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dreb-worktree-test-")));
		repoDir = join(tempDir, "myrepo");
		execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
		initRepo(repoDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("listWorktrees", () => {
		it("lists the main worktree", () => {
			const worktrees = listWorktrees(repoDir);
			expect(worktrees).toHaveLength(1);
			expect(worktrees[0].path).toBe(repoDir);
			expect(worktrees[0].head).toMatch(/^[0-9a-f]{40}$/);
		});

		it("lists additional worktrees with their branches", () => {
			git(repoDir, "branch feature-x");
			const wtPath = join(tempDir, "wt-feature-x");
			git(repoDir, `worktree add ${JSON.stringify(wtPath)} feature-x`);

			const worktrees = listWorktrees(repoDir);
			expect(worktrees).toHaveLength(2);

			const feature = worktrees.find((w) => w.path === wtPath);
			expect(feature).toBeDefined();
			expect(feature?.branch).toBe("feature-x");
			expect(feature?.head).toMatch(/^[0-9a-f]{40}$/);
		});

		it("returns an empty array when not in a git repo", () => {
			const nonRepo = join(tempDir, "not-a-repo");
			execSync(`mkdir -p ${JSON.stringify(nonRepo)}`);
			expect(listWorktrees(nonRepo)).toEqual([]);
		});
	});

	describe("findWorktreeForBranch", () => {
		it("finds the path of an existing branch worktree", () => {
			git(repoDir, "branch feature-y");
			const wtPath = join(tempDir, "wt-feature-y");
			git(repoDir, `worktree add ${JSON.stringify(wtPath)} feature-y`);

			expect(findWorktreeForBranch(repoDir, "feature-y")).toBe(wtPath);
		});

		it("accepts a full refs/heads/ prefixed branch name", () => {
			git(repoDir, "branch feature-z");
			const wtPath = join(tempDir, "wt-feature-z");
			git(repoDir, `worktree add ${JSON.stringify(wtPath)} feature-z`);

			expect(findWorktreeForBranch(repoDir, "refs/heads/feature-z")).toBe(wtPath);
		});

		it("returns undefined when no worktree exists for the branch", () => {
			expect(findWorktreeForBranch(repoDir, "nonexistent")).toBeUndefined();
		});
	});

	describe("getWorktreePath", () => {
		it("computes the conventional path", () => {
			const result = getWorktreePath("/home/user/myrepo", 42);
			expect(result).toBe(join("/home/user", "myrepo-worktrees", "issue-42"));
		});

		it("derives the repo name from the basename", () => {
			const repoRoot = "/some/deep/path/cool-project";
			const result = getWorktreePath(repoRoot, 7);
			expect(basename(dirname(dirname(result)))).toBe("path");
			expect(result).toBe(join("/some/deep/path", "cool-project-worktrees", "issue-7"));
		});
	});

	describe("createWorktree", () => {
		it("creates a worktree at the conventional path", () => {
			git(repoDir, "branch issue-branch");

			const path = createWorktree(repoDir, "issue-branch", 100);
			const expected = getWorktreePath(repoDir, 100);

			expect(path).toBe(expected);
			expect(existsSync(path)).toBe(true);
			expect(findWorktreeForBranch(repoDir, "issue-branch")).toBe(path);
		});

		it("reuses an existing worktree for the branch", () => {
			git(repoDir, "branch dup-branch");
			const existingPath = join(tempDir, "existing-wt");
			git(repoDir, `worktree add ${JSON.stringify(existingPath)} dup-branch`);

			const path = createWorktree(repoDir, "dup-branch", 200);
			expect(path).toBe(existingPath);

			// No new conventional worktree should have been created.
			expect(existsSync(getWorktreePath(repoDir, 200))).toBe(false);
		});
	});
});
