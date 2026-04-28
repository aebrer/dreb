import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getGitRepoState } from "../src/core/git-repo-state.js";

describe("getGitRepoState", () => {
	describe("real repo tests", () => {
		const state = getGitRepoState(process.cwd());

		test("returns non-null for this repo", () => {
			expect(state).not.toBeNull();
		});

		test("has a non-empty branch string", () => {
			expect(state!.branch).toBeTruthy();
			expect(typeof state!.branch).toBe("string");
		});

		test("has dirtyCount as a number >= 0", () => {
			expect(typeof state!.dirtyCount).toBe("number");
			expect(state!.dirtyCount).toBeGreaterThanOrEqual(0);
		});

		test("has recentCommits as a non-empty array with hash and subject", () => {
			expect(Array.isArray(state!.recentCommits)).toBe(true);
			expect(state!.recentCommits.length).toBeGreaterThan(0);
			for (const commit of state!.recentCommits) {
				expect(commit).toHaveProperty("hash");
				expect(commit).toHaveProperty("subject");
			}
		});

		test("has recentTags as an array", () => {
			expect(Array.isArray(state!.recentTags)).toBe(true);
		});

		test("has openPRs as an array", () => {
			expect(Array.isArray(state!.openPRs)).toBe(true);
		});
	});

	describe("non-repo test", () => {
		test("returns null for a directory outside any git repo", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "git-repo-state-test-"));
			expect(getGitRepoState(tempDir)).toBeNull();
		});
	});

	describe("parsing tests", () => {
		const state = getGitRepoState(process.cwd());

		test("each commit has a short hash (7+ alphanumeric chars) and non-empty subject", () => {
			expect(state).not.toBeNull();
			for (const commit of state!.recentCommits) {
				expect(commit.hash).toMatch(/^[a-f0-9]{7,}$/);
				expect(commit.subject.length).toBeGreaterThan(0);
			}
		});

		test("if tags exist, each tag has a name and date string", () => {
			expect(state).not.toBeNull();
			if (state!.recentTags.length > 0) {
				for (const tag of state!.recentTags) {
					expect(tag.name.length).toBeGreaterThan(0);
					expect(typeof tag.date).toBe("string");
				}
			}
		});
	});
});
