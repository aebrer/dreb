import { type ExecFileException, execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
export function findGitPaths(cwd: string = process.cwd()): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				/* Not inside a git repository, or git dir unreadable */
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
export function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

/** Resolve the current git branch for cwd. Returns null outside git, "detached" for detached HEAD. */
export function getGitBranch(cwd: string = process.cwd()): string | null {
	try {
		const gitPaths = findGitPaths(cwd);
		if (!gitPaths) return null;
		const content = readFileSync(gitPaths.headPath, "utf8").trim();
		if (content.startsWith("ref: refs/heads/")) {
			const branch = content.slice(16);
			return branch === ".invalid" ? (resolveBranchWithGitSync(gitPaths.repoDir) ?? "detached") : branch;
		}
		return "detached";
	} catch {
		/* Git HEAD unreadable — branch display unavailable */
		return null;
	}
}

/** Async variant of getGitBranch for watcher refreshes. */
export async function getGitBranchAsync(cwd: string = process.cwd()): Promise<string | null> {
	try {
		const gitPaths = findGitPaths(cwd);
		if (!gitPaths) return null;
		const content = readFileSync(gitPaths.headPath, "utf8").trim();
		if (content.startsWith("ref: refs/heads/")) {
			const branch = content.slice(16);
			return branch === ".invalid" ? ((await resolveBranchWithGitAsync(gitPaths.repoDir)) ?? "detached") : branch;
		}
		return "detached";
	} catch {
		/* Git HEAD unreadable — branch display unavailable */
		return null;
	}
}
