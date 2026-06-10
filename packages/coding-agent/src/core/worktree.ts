import { execSync, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { gitEnv } from "./git-env.js";

export interface WorktreeInfo {
	path: string;
	head: string; // commit SHA
	branch?: string; // branch name without refs/heads/ prefix
	bare?: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured data.
 * Runs the command in the given directory.
 *
 * Returns an empty array if the command fails (e.g. not in a git repo).
 */
export function listWorktrees(cwd: string): WorktreeInfo[] {
	let output: string;
	try {
		output = execSync("git worktree list --porcelain", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			env: gitEnv(),
		});
	} catch {
		return [];
	}

	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> | null = null;

	const flush = () => {
		if (current?.path) {
			worktrees.push({
				path: current.path,
				head: current.head ?? "",
				branch: current.branch,
				bare: current.bare,
			});
		}
		current = null;
	};

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") {
			// Blank line separates worktree blocks
			flush();
			continue;
		}

		if (line.startsWith("worktree ")) {
			// Start of a new block
			flush();
			current = { path: line.slice("worktree ".length) };
		} else if (!current) {
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "bare") {
			current.bare = true;
		} else if (line === "detached") {
			current.branch = undefined;
		}
	}
	// Flush any trailing block (output may not end with a blank line)
	flush();

	return worktrees;
}

/**
 * Find an existing worktree for a given branch name.
 * Returns the worktree path or undefined if no worktree exists for that branch.
 *
 * Accepts either a bare branch name or a full `refs/heads/` prefixed name.
 */
export function findWorktreeForBranch(cwd: string, branch: string): string | undefined {
	const normalized = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;

	const match = listWorktrees(cwd).find((wt) => wt.branch === normalized);
	return match?.path;
}

/**
 * Compute the conventional worktree path for an issue number.
 * Convention: <repo-parent>/<repo-name>-worktrees/issue-<N>/
 */
export function getWorktreePath(repoRoot: string, issueNumber: number): string {
	const repoName = basename(repoRoot);
	const parentDir = dirname(repoRoot);
	return join(parentDir, `${repoName}-worktrees`, `issue-${issueNumber}`);
}

/**
 * Create a worktree for a branch at the conventional path.
 * If a worktree already exists for the branch, returns its path without
 * creating a new one.
 *
 * Returns the absolute path to the worktree.
 */
export function createWorktree(cwd: string, branch: string, issueNumber: number): string {
	// Reuse an existing worktree for this branch if present.
	const existing = findWorktreeForBranch(cwd, branch);
	if (existing) return existing;

	const repoRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: gitEnv(),
	});
	if (repoRootResult.status !== 0) {
		throw new Error(`Failed to find git root: ${repoRootResult.stderr?.trim() || "unknown error"}`);
	}
	const repoRoot = repoRootResult.stdout.trim();

	const target = getWorktreePath(repoRoot, issueNumber);

	const addResult = spawnSync("git", ["worktree", "add", target, branch], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env: gitEnv(),
	});
	if (addResult.status !== 0) {
		throw new Error(`Failed to create worktree: ${addResult.stderr?.trim() || "unknown error"}`);
	}

	return target;
}
