/**
 * Create a clean environment for git commands.
 * Removes GIT_DIR, GIT_INDEX_FILE, and GIT_WORK_TREE to prevent inherited
 * env vars (e.g. from git hooks) from causing git to use the wrong repo.
 */
export function gitEnv(): NodeJS.ProcessEnv {
	const { GIT_DIR: _, GIT_INDEX_FILE: __, GIT_WORK_TREE: ___, ...env } = process.env;
	return env;
}
