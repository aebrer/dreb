import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

vi.mock("../src/core/git-root.js", () => ({
	findGitRoot: vi.fn(() => "/fake/repo"),
}));

import { getGitRepoState } from "../src/core/git-repo-state.js";

function makeSpawnResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
	return {
		pid: 1234,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	} as SpawnSyncReturns<string>;
}

const mockedSpawnSync = vi.mocked(spawnSync);

describe("getGitRepoState edge cases (mocked spawnSync)", () => {
	beforeEach(() => {
		mockedSpawnSync.mockReset();
	});

	test("returns null when git binary is missing (ENOENT, status: null)", () => {
		mockedSpawnSync.mockReturnValue(
			makeSpawnResult({ status: null, stdout: null as unknown as string, error: new Error("ENOENT") }),
		);
		expect(getGitRepoState("/fake/repo")).toBeNull();
	});

	test("detached HEAD does not call gh pr list", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "status") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "" });
			if (cmd === "gh") throw new Error("gh should not be called for detached HEAD");
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.branch).toBe("detached");
		expect(result!.openPRs).toEqual([]);
	});

	test("malformed JSON from gh results in empty openPRs", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "main\n" });
			if (cmd === "git" && args?.[0] === "status") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "abc1234 fix stuff\n" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "" });
			if (cmd === "gh") return makeSpawnResult({ stdout: "not json{{{" });
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.openPRs).toEqual([]);
	});

	test("git log line with no space produces hash with empty subject", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "main\n" });
			if (cmd === "git" && args?.[0] === "status") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "abc1234\n" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "" });
			if (cmd === "gh") return makeSpawnResult({ stdout: "[]" });
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.recentCommits).toEqual([{ hash: "abc1234", subject: "" }]);
	});

	test("git tag line with no space produces name with empty date", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "main\n" });
			if (cmd === "git" && args?.[0] === "status") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "abc1234 fix stuff\n" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "v1.0.0\n" });
			if (cmd === "gh") return makeSpawnResult({ stdout: "[]" });
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.recentTags).toEqual([{ name: "v1.0.0", date: "" }]);
	});

	test("returns null when git branch exits non-zero with empty stdout", () => {
		mockedSpawnSync.mockReturnValue(makeSpawnResult({ status: 128, stdout: "" }));
		expect(getGitRepoState("/fake/repo")).toBeNull();
	});

	test("parses multi-line porcelain output for correct dirtyCount", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "main\n" });
			if (cmd === "git" && args?.[0] === "status")
				return makeSpawnResult({ stdout: " M file1.ts\nA  file2.ts\n?? new.ts\n" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "abc1234 fix stuff\n" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "" });
			if (cmd === "gh") return makeSpawnResult({ stdout: "[]" });
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.dirtyCount).toBe(3);
	});

	test("non-array JSON from gh results in empty openPRs", () => {
		mockedSpawnSync.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === "git" && args?.[0] === "branch") return makeSpawnResult({ stdout: "main\n" });
			if (cmd === "git" && args?.[0] === "status") return makeSpawnResult({ stdout: "" });
			if (cmd === "git" && args?.[0] === "log") return makeSpawnResult({ stdout: "abc1234 fix stuff\n" });
			if (cmd === "git" && args?.[0] === "tag") return makeSpawnResult({ stdout: "" });
			if (cmd === "gh") return makeSpawnResult({ stdout: '{"message":"error"}' });
			return makeSpawnResult();
		}) as typeof spawnSync);

		const result = getGitRepoState("/fake/repo");
		expect(result).not.toBeNull();
		expect(result!.openPRs).toEqual([]);
	});
});
