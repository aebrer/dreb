import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../src/core/tools/truncate.js";
import {
	createLocalGithubCiOperations,
	createWatchGithubCiToolDefinition,
	type GithubCiOperations,
} from "../../src/core/tools/watch-github-ci.js";
import * as shellModule from "../../src/utils/shell.js";

interface OperationStep {
	exitCode: number | null;
	output?: string | string[];
	error?: Error;
}

function operationsSequence(...steps: OperationStep[]): GithubCiOperations {
	let callIndex = 0;
	return {
		exec: vi.fn(async (_args, _cwd, { onData }) => {
			const step = steps[callIndex++];
			if (!step) throw new Error(`Unexpected GitHub CI operation ${callIndex}`);
			const outputs = Array.isArray(step.output) ? step.output : [step.output];
			for (const output of outputs) {
				if (output) onData(Buffer.from(output));
			}
			if (step.error) throw step.error;
			return { exitCode: step.exitCode };
		}),
	};
}

function completedOperations(exitCode: 0 | 1, finalOutput: string, watchOutput = "watch output"): GithubCiOperations {
	return operationsSequence({ exitCode, output: watchOutput }, { exitCode, output: finalOutput });
}

async function execute(
	operations: GithubCiOperations,
	params: { pr?: string } = {},
	signal?: AbortSignal,
	onUpdate?: (update: any) => void,
) {
	const tool = createWatchGithubCiToolDefinition("/repo", { operations });
	return tool.execute("watch-1", params, signal, onUpdate, undefined as any);
}

describe("watch_github_ci tool", () => {
	it("watches and then queries the current branch pull request by default", async () => {
		const operations = completedOperations(0, "build passed");
		await execute(operations);

		expect(operations.exec).toHaveBeenCalledTimes(2);
		const [watchArgs, watchCwd, watchOptions] = vi.mocked(operations.exec).mock.calls[0];
		const [finalArgs, finalCwd, finalOptions] = vi.mocked(operations.exec).mock.calls[1];
		expect(watchArgs).toEqual(["pr", "checks", "--watch", "--fail-fast"]);
		expect(finalArgs).toEqual(["pr", "checks"]);
		expect(watchCwd).toBe("/repo");
		expect(finalCwd).toBe("/repo");
		expect(watchOptions.env).toMatchObject({ GH_PAGER: "cat", GH_EDITOR: "cat", NO_COLOR: "1" });
		expect(finalOptions.env).toBe(watchOptions.env);
	});

	it("forwards a trimmed explicit pull request selector to both commands", async () => {
		const operations = completedOperations(0, "build passed");
		await execute(operations, { pr: "  426  " });

		expect(vi.mocked(operations.exec).mock.calls[0][0]).toEqual(["pr", "checks", "426", "--watch", "--fail-fast"]);
		expect(vi.mocked(operations.exec).mock.calls[1][0]).toEqual(["pr", "checks", "426"]);
	});

	it("rejects a blank pull request selector", async () => {
		const operations = operationsSequence({ exitCode: 0 });
		await expect(execute(operations, { pr: "   " })).rejects.toThrow("must not be blank");
		expect(operations.exec).not.toHaveBeenCalled();
	});

	it("rejects option-like selectors before spawning", async () => {
		const operations = operationsSequence({ exitCode: 0 });
		await expect(execute(operations, { pr: "--repo" })).rejects.toThrow("must not begin with '-'");
		expect(operations.exec).not.toHaveBeenCalled();
	});

	it("returns only clean final output and passed details for exit code zero", async () => {
		const operations = completedOperations(
			0,
			"build passed",
			"Refreshing checks status every 10 seconds.\n\nbuild\tpending\t0\thttps://example.test/watch",
		);
		const result = await execute(operations);

		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub CI checks passed.\n\nbuild passed",
		});
		expect((result.content[0] as { text: string }).text).not.toContain("Refreshing checks status");
		expect(result.details).toEqual({ status: "passed", exitCode: 0, outputTruncated: false });
		expect(result.endTurn).toBeUndefined();
	});

	it("returns only clean failed-check output without turning it into a tool execution error", async () => {
		const operations = completedOperations(
			1,
			"build failed",
			"Refreshing checks status every 10 seconds.\n\nbuild\tpending\t0\thttps://example.test/watch",
		);
		const result = await execute(operations);

		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub CI checks did not pass. The GitHub CLI exited with code 1.\n\nbuild failed",
		});
		expect((result.content[0] as { text: string }).text).not.toContain("Refreshing checks status");
		expect(result.details).toEqual({ status: "failed", exitCode: 1, outputTruncated: false });
	});

	it("rejects a no-pull-request watch error without running the final query", async () => {
		const operations = operationsSequence({
			exitCode: 1,
			output: 'no pull requests found for branch "ghost-branch"',
		});

		await expect(execute(operations)).rejects.toThrow("could not query checks");
		await expect(execute(operationsSequence({ exitCode: 1, output: "no pull requests found" }))).rejects.toThrow(
			"no pull requests found",
		);
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it.each([
		"GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)",
		"failed to run git: fatal: not a git repository",
		"HTTP 401: Bad credentials (https://api.github.com/graphql)",
		"could not parse the pull request selector",
	])("rejects watch CLI failure output %s without running the final query", async (output) => {
		const operations = operationsSequence({ exitCode: 1, output });
		await expect(execute(operations)).rejects.toThrow("could not query checks");
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it("refuses to query final results after pending watch exit code 8", async () => {
		const operations = operationsSequence({ exitCode: 8, output: "checks pending" });
		await expect(execute(operations)).rejects.toThrow("checks were still pending (exit code 8)");
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it.each([null, 2, 4])("surfaces unexpected watch exit code %s without a final query", async (exitCode) => {
		const operations = operationsSequence({ exitCode, output: "gh diagnostic" });
		await expect(execute(operations)).rejects.toThrow("exited unexpectedly");
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it("preserves buffered watch output when process execution fails", async () => {
		const operations = operationsSequence({
			exitCode: null,
			output: "authentication required",
			error: new Error("spawn failed"),
		});

		await expect(execute(operations)).rejects.toThrow(
			"authentication required\n\nGitHub CI watch could not run: spawn failed",
		);
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it("reports watch cancellation distinctly and forwards the AbortSignal", async () => {
		const controller = new AbortController();
		const operations: GithubCiOperations = {
			exec: vi.fn(async (_args, _cwd, { signal }) => {
				expect(signal).toBe(controller.signal);
				throw new Error("aborted");
			}),
		};

		await expect(execute(operations, {}, controller.signal)).rejects.toThrow("GitHub CI watch aborted");
		expect(operations.exec).toHaveBeenCalledOnce();
	});

	it("forwards the same AbortSignal to the watch and final query", async () => {
		const controller = new AbortController();
		const operations = completedOperations(0, "build passed");
		await execute(operations, {}, controller.signal);

		expect(vi.mocked(operations.exec).mock.calls[0][2].signal).toBe(controller.signal);
		expect(vi.mocked(operations.exec).mock.calls[1][2].signal).toBe(controller.signal);
	});

	it("keeps repeated watch output in live updates but not the final result", async () => {
		const updates: any[] = [];
		const watchSnapshots = [
			"Refreshing checks status every 10 seconds.\n\nbuild\tpending\t0\thttps://example.test/build\n",
			"Refreshing checks status every 10 seconds.\n\nbuild\tpass\t1m\thttps://example.test/build\n",
		];
		const operations = operationsSequence(
			{ exitCode: 0, output: watchSnapshots },
			{ exitCode: 0, output: "build\tpass\t1m\thttps://example.test/build" },
		);
		const result = await execute(operations, {}, undefined, (update) => updates.push(update));

		expect(updates[0]).toEqual({
			content: [],
			details: { status: "watching", exitCode: undefined, outputTruncated: false },
		});
		const lastUpdateText = updates.at(-1).content[0].text as string;
		expect(lastUpdateText).toMatch(/build\s+pending/);
		expect(lastUpdateText).toMatch(/build\s+pass/);
		expect((result.content[0] as { text: string }).text).not.toContain("Refreshing checks status");
	});

	it("keeps watch truncation independent from the final result", async () => {
		const updates: any[] = [];
		const operations = operationsSequence(
			{
				exitCode: 0,
				output: ["x".repeat(DEFAULT_MAX_BYTES * 2), "y".repeat(DEFAULT_MAX_BYTES * 2)],
			},
			{ exitCode: 0, output: "build passed" },
		);
		const result = await execute(operations, {}, undefined, (update) => updates.push(update));

		expect(updates.at(-1).details).toMatchObject({ status: "watching", outputTruncated: true });
		expect(result.details).toEqual({ status: "passed", exitCode: 0, outputTruncated: false });
		expect(result.content[0]).toEqual({ type: "text", text: "GitHub CI checks passed.\n\nbuild passed" });
	});

	it("bounds and reports truncation of the separate final query output", async () => {
		const updates: any[] = [];
		const operations = completedOperations(0, "z".repeat(DEFAULT_MAX_BYTES * 3), "watch output");
		const result = await execute(operations, {}, undefined, (update) => updates.push(update));
		const resultText = (result.content[0] as { text: string }).text;

		expect(updates.at(-1).details.outputTruncated).toBe(false);
		expect(result.details?.outputTruncated).toBe(true);
		expect(resultText).toContain("[Earlier final checks output omitted]");
		expect(resultText.length).toBeLessThan(DEFAULT_MAX_BYTES + 500);
	});

	it("preserves final query output when that process fails", async () => {
		const operations = operationsSequence(
			{ exitCode: 0, output: "watch complete" },
			{ exitCode: null, output: "final diagnostic", error: new Error("spawn failed") },
		);

		await expect(execute(operations)).rejects.toThrow(
			"final diagnostic\n\nGitHub CI final checks query could not run: spawn failed",
		);
	});

	it("reports final query cancellation distinctly", async () => {
		const controller = new AbortController();
		const operations = operationsSequence(
			{ exitCode: 0, output: "watch complete" },
			{ exitCode: null, error: new Error("aborted") },
		);

		await expect(execute(operations, {}, controller.signal)).rejects.toThrow("final checks query aborted");
	});

	it("rejects a CLI-level failure from the final query", async () => {
		const operations = operationsSequence(
			{ exitCode: 1, output: "build failed" },
			{ exitCode: 1, output: "HTTP 401: Bad credentials" },
		);

		await expect(execute(operations)).rejects.toThrow("final checks query failed");
	});

	it("rejects pending final query results", async () => {
		const operations = operationsSequence(
			{ exitCode: 0, output: "watch complete" },
			{ exitCode: 8, output: "checks pending again" },
		);

		await expect(execute(operations)).rejects.toThrow("checks still pending (exit code 8)");
	});

	it.each([null, 2, 4])("surfaces unexpected final query exit code %s loudly", async (exitCode) => {
		const operations = operationsSequence(
			{ exitCode: 0, output: "watch complete" },
			{ exitCode, output: "final diagnostic" },
		);
		await expect(execute(operations)).rejects.toThrow("final checks query exited unexpectedly");
	});

	it.each([
		{ watchExitCode: 0 as const, finalExitCode: 1 as const },
		{ watchExitCode: 1 as const, finalExitCode: 0 as const },
	])("rejects contradictory watch $watchExitCode and final $finalExitCode states", async (testCase) => {
		const operations = operationsSequence(
			{ exitCode: testCase.watchExitCode, output: "watch complete" },
			{ exitCode: testCase.finalExitCode, output: "final state" },
		);
		await expect(execute(operations)).rejects.toThrow("status changed between watch completion");
	});

	it("has prompt metadata that forbids wait and polling", () => {
		const tool = createWatchGithubCiToolDefinition("/repo", {
			operations: completedOperations(0, "build passed"),
		});
		const guidance = tool.promptGuidelines?.join(" ") ?? "";

		expect(tool.name).toBe("watch_github_ci");
		expect(tool.promptSnippet).toContain("until checks pass or fail");
		expect(guidance).toContain("instead of asking the user");
		expect(guidance).toContain("polling");
		expect(guidance).toContain("`wait`");
	});
});

describe("createLocalGithubCiOperations", () => {
	let cwd: string | undefined;
	let bins: string[] | undefined;

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
		vi.restoreAllMocks();
		for (const bin of bins ?? []) rmSync(bin, { recursive: true, force: true });
		bins = undefined;
	});

	it("rejects before spawning when already aborted", async () => {
		cwd = mkdtempSync(join(tmpdir(), "watch-github-ci-"));
		const controller = new AbortController();
		controller.abort();

		await expect(
			createLocalGithubCiOperations().exec(["pr", "checks", "--watch"], cwd, {
				onData: () => {},
				signal: controller.signal,
				env: process.env,
			}),
		).rejects.toThrow("aborted");
	});

	it("rejects a missing working directory", async () => {
		await expect(
			createLocalGithubCiOperations().exec(["pr", "checks", "--watch"], "/definitely/missing/dreb-cwd", {
				onData: () => {},
				env: process.env,
			}),
		).rejects.toThrow("Working directory does not exist");
	});

	it("kills the process tree when the AbortSignal fires mid-watch", async () => {
		// Skip on platforms without a POSIX shell / SIGKILL semantics used by killProcessTree.
		if (process.platform === "win32") return;

		cwd = mkdtempSync(join(tmpdir(), "watch-github-ci-abort-"));
		const binDir = mkdtempSync(join(tmpdir(), "watch-github-ci-bin-"));
		if (!bins) bins = [];
		bins.push(binDir);
		const ghPath = join(binDir, "gh");
		// Fake `gh` that lingers long enough to be aborted mid-watch.
		writeFileSync(ghPath, "#!/bin/sh\nsleep 30\n");
		chmodSync(ghPath, 0o755);

		const killSpy = vi.spyOn(shellModule, "killProcessTree").mockImplementation((pid: number) => {
			// Actually kill the process group so the fake `gh` does not leak past the test,
			// while still recording that killProcessTree was invoked.
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already dead
				}
			}
		});

		const controller = new AbortController();
		const execPromise = createLocalGithubCiOperations().exec(["pr", "checks", "--watch", "--fail-fast"], cwd, {
			onData: () => {},
			signal: controller.signal,
			// Prepend the bin dir so our fake `gh` resolves first while system
			// utilities such as `sleep` (used by the shim) remain available.
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
		});

		// Give the child a moment to spawn, then abort mid-watch.
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort();

		await expect(execPromise).rejects.toThrow("aborted");
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(typeof killSpy.mock.calls[0]?.[0]).toBe("number");
		expect(killSpy.mock.calls[0]?.[0]).toBeGreaterThan(0);
	});

	it("surfaces a loud spawn error when `gh` is not installed (ENOENT)", async () => {
		cwd = mkdtempSync(join(tmpdir(), "watch-github-ci-no-gh-"));

		await expect(
			createLocalGithubCiOperations().exec(["pr", "checks", "--watch"], cwd, {
				onData: () => {},
				env: { ...process.env, PATH: "" },
			}),
		).rejects.toThrow(/ENOENT|gh/i);
	});
});
