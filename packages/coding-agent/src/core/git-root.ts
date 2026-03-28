import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Walk upward from `cwd` looking for a `.git` directory or file (worktrees use a `.git` file).
 * Returns the directory containing `.git`, or `null` if not in a git repo.
 */
export function findGitRoot(cwd: string): string | null {
	let current = resolve(cwd);
	const root = resolve("/");

	while (true) {
		const gitPath = join(current, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isDirectory() || stat.isFile()) {
					return current;
				}
			} catch {
				// stat failed, keep walking
			}
		}

		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	return null;
}
