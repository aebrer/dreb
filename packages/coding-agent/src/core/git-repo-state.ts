import { spawnSync } from "node:child_process";
import { findGitRoot } from "./git-root.js";

export interface GitRepoState {
	branch: string;
	dirtyCount: number;
	recentCommits: Array<{ hash: string; subject: string }>;
	recentTags: Array<{ name: string; date: string }>;
	openPRs: Array<{ number: number; title: string; url: string }>;
}

const SPAWN_OPTS: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] } = {
	encoding: "utf8",
	timeout: 5000,
	stdio: ["ignore", "pipe", "ignore"],
};

export function getGitRepoState(cwd: string): GitRepoState | null {
	if (!findGitRoot(cwd)) return null;

	// Branch
	const branchResult = spawnSync("git", ["branch", "--show-current"], { ...SPAWN_OPTS, cwd });
	// git binary unavailable (ENOENT) or timed out (status: null)
	if (branchResult.status === null) return null;
	if (branchResult.status !== 0 && !branchResult.stdout) return null;
	const branch = branchResult.stdout?.trim() || "detached";

	// Dirty count
	const statusResult = spawnSync("git", ["status", "--porcelain"], { ...SPAWN_OPTS, cwd });
	let dirtyCount = 0;
	if (statusResult.status === 0 && statusResult.stdout) {
		dirtyCount = statusResult.stdout.split("\n").filter((line) => line.length > 0).length;
	}

	// Recent commits
	const logResult = spawnSync("git", ["log", "--oneline", "-n", "3", "--no-decorate"], {
		...SPAWN_OPTS,
		cwd,
	});
	const recentCommits: Array<{ hash: string; subject: string }> = [];
	if (logResult.status === 0 && logResult.stdout) {
		for (const line of logResult.stdout.trim().split("\n")) {
			if (!line) continue;
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) {
				recentCommits.push({ hash: line, subject: "" });
			} else {
				recentCommits.push({
					hash: line.slice(0, spaceIdx),
					subject: line.slice(spaceIdx + 1),
				});
			}
		}
	}

	// Recent tags
	const tagResult = spawnSync(
		"git",
		["tag", "--sort=-creatordate", "--format=%(refname:short) %(creatordate:relative)"],
		{ ...SPAWN_OPTS, cwd },
	);
	const recentTags: Array<{ name: string; date: string }> = [];
	if (tagResult.status === 0 && tagResult.stdout) {
		const lines = tagResult.stdout.trim().split("\n");
		for (const line of lines.slice(0, 3)) {
			if (!line) continue;
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) {
				recentTags.push({ name: line, date: "" });
			} else {
				recentTags.push({
					name: line.slice(0, spaceIdx),
					date: line.slice(spaceIdx + 1),
				});
			}
		}
	}

	// Open PRs (network call — fail silently)
	let openPRs: Array<{ number: number; title: string; url: string }> = [];
	if (branch !== "detached") {
		const prResult = spawnSync(
			"gh",
			["pr", "list", "--head", branch, "--state", "open", "--json", "number,title,url", "--limit", "3"],
			{ ...SPAWN_OPTS, cwd },
		);
		if (prResult.status === 0 && prResult.stdout) {
			try {
				const parsed = JSON.parse(prResult.stdout);
				if (Array.isArray(parsed)) {
					openPRs = parsed;
				}
			} catch {
				// malformed JSON — keep empty array
			}
		}
	}

	return { branch, dirtyCount, recentCommits, recentTags, openPRs };
}
