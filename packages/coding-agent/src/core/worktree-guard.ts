import { findGitRoot } from "./git-root.js";
import { listWorktrees } from "./worktree.js";

export interface WorktreeConflictResult {
	blocked: boolean;
	reason?: string;
	worktreePath?: string;
}

/**
 * Cache for worktree list to avoid running git commands on every bash call.
 * Keyed by git root. Invalidated after 30 seconds.
 */
const worktreeCache = new Map<string, { worktrees: Map<string, string>; timestamp: number }>();
const CACHE_TTL_MS = 30_000;

function getWorktreeBranches(cwd: string): Map<string, string> | undefined {
	const gitRoot = findGitRoot(cwd);
	if (!gitRoot) return undefined;

	const now = Date.now();
	const cached = worktreeCache.get(gitRoot);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		return cached.worktrees;
	}

	const allWorktrees = listWorktrees(gitRoot);
	if (allWorktrees.length === 0) return undefined;

	// Skip the first entry (primary working copy) and build branch→path map
	const worktrees = new Map<string, string>();
	for (const wt of allWorktrees.slice(1)) {
		if (wt.branch) {
			worktrees.set(wt.branch, wt.path);
		}
	}
	worktreeCache.set(gitRoot, { worktrees, timestamp: now });
	return worktrees;
}

/**
 * Strip heredoc content from a bash command so that text inside heredoc bodies
 * doesn't trigger false-positive pattern matches.
 *
 * Handles both quoted delimiters (<<'EOF', <<"EOF") and unquoted (<<EOF).
 */
function stripHeredocs(command: string): string {
	// Match heredoc start: << [-]? ['"]?DELIMITER['"]?
	// Then remove everything up to and including the delimiter line
	return command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\t*\1\b[^\n]*/g, "");
}

/**
 * Extract the target branch from a git checkout/switch command.
 * Returns undefined if the command is not a branch checkout (e.g., file checkout).
 */
function extractBranchTarget(command: string): string | undefined {
	// Match: git checkout <branch> (but NOT git checkout -- <file> or git checkout -b)
	// Match: git switch <branch> (but NOT git switch -c)
	// Match: gh pr checkout <number> — we can't easily resolve PR number to branch,
	//   so we return a special marker

	// Strip heredoc bodies to avoid false positives from PR comment content
	const trimmed = stripHeredocs(command).trim();

	// git checkout -- <file> → not a branch checkout
	if (/\bgit\s+checkout\s+--\s/.test(trimmed)) return undefined;
	// git checkout -b → creating new branch (allowed)
	if (/\bgit\s+checkout\s+-[bB]\s/.test(trimmed)) return undefined;
	// git checkout <branch>
	const checkoutMatch = trimmed.match(/\bgit\s+checkout\s+([\w\-./]+)/);
	if (checkoutMatch) return checkoutMatch[1];

	// git switch -c → creating new branch (allowed)
	if (/\bgit\s+switch\s+-[cC]\s/.test(trimmed)) return undefined;
	// git switch <branch>
	const switchMatch = trimmed.match(/\bgit\s+switch\s+([\w\-./]+)/);
	if (switchMatch) return switchMatch[1];

	// gh pr checkout <N> — can't resolve to branch name without API call
	// Block any gh pr checkout when worktrees exist
	if (/\bgh\s+pr\s+checkout\b/.test(trimmed)) return "__gh_pr_checkout__";

	return undefined;
}

/**
 * Check if a bash command would conflict with an existing worktree.
 * Called from the agent-session bash guard.
 */
export function isWorktreeConflictCommand(command: string, cwd: string): WorktreeConflictResult {
	const branch = extractBranchTarget(command);
	if (!branch) return { blocked: false };

	const worktrees = getWorktreeBranches(cwd);
	if (!worktrees || worktrees.size === 0) return { blocked: false };

	// Special case: gh pr checkout — block if any worktrees exist
	if (branch === "__gh_pr_checkout__") {
		return {
			blocked: true,
			reason: `Command blocked: \`gh pr checkout\` is not allowed when worktrees exist. Use the \`chdir\` tool to switch to the appropriate worktree instead.\n\nExisting worktrees:\n${Array.from(
				worktrees.entries(),
			)
				.map(([b, p]) => `  ${b} → ${p}`)
				.join("\n")}`,
		};
	}

	// Check if the target branch has a worktree
	const worktreePath = worktrees.get(branch);
	if (!worktreePath) return { blocked: false };

	return {
		blocked: true,
		reason: `Command blocked: Branch "${branch}" already has an active worktree at:\n  ${worktreePath}\n\nUse the \`chdir\` tool to switch to it instead of checking out the branch.`,
		worktreePath,
	};
}

/** Clear the worktree cache. Useful after creating/removing worktrees. */
export function clearWorktreeCache(): void {
	worktreeCache.clear();
}

// Export for testing
export { extractBranchTarget as _extractBranchTarget, stripHeredocs as _stripHeredocs };
