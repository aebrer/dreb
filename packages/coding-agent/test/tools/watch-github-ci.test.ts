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

function operationsResult(exitCode: number | null, output = "checks output"): GithubCiOperations {
	return {
		exec: vi.fn(async (_args, _cwd, { onData }) => {
			if (output) onData(Buffer.from(output));
			return { exitCode };
		}),
	};
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
	it("uses the current branch pull request by default", async () => {
		const operations = operationsResult(0);
		await execute(operations);

		expect(operations.exec).toHaveBeenCalledOnce();
		const [args, cwd, options] = vi.mocked(operations.exec).mock.calls[0];
		expect(args).toEqual(["pr", "checks", "--watch", "--fail-fast"]);
		expect(cwd).toBe("/repo");
		expect(options.env).toMatchObject({ GH_PAGER: "cat", GH_EDITOR: "cat", NO_COLOR: "1" });
	});

	it("forwards a trimmed explicit pull request selector as one argument", async () => {
		const operations = operationsResult(0);
		await execute(operations, { pr: "  426  " });

		expect(vi.mocked(operations.exec).mock.calls[0][0]).toEqual(["pr", "checks", "426", "--watch", "--fail-fast"]);
	});

	it("rejects a blank pull request selector", async () => {
		const operations = operationsResult(0);
		await expect(execute(operations, { pr: "   " })).rejects.toThrow("must not be blank");
		expect(operations.exec).not.toHaveBeenCalled();
	});

	it("rejects option-like selectors before spawning", async () => {
		const operations = operationsResult(0);
		await expect(execute(operations, { pr: "--repo" })).rejects.toThrow("must not begin with '-'");
		expect(operations.exec).not.toHaveBeenCalled();
	});

	it("returns final output and passed details for exit code zero", async () => {
		const result = await execute(operationsResult(0, "build passed"));

		expect(result.content[0]).toEqual({ type: "text", text: "GitHub CI checks passed.\n\nbuild passed" });
		expect(result.details).toEqual({ status: "passed", exitCode: 0, outputTruncated: false });
		expect(result.endTurn).toBeUndefined();
	});

	it("returns failed check output without turning it into a tool execution error", async () => {
		const result = await execute(operationsResult(1, "build failed"));

		expect(result.content[0]).toEqual({
			type: "text",
			text: "GitHub CI checks did not pass. The GitHub CLI exited with code 1.\n\nbuild failed",
		});
		expect(result.details).toEqual({ status: "failed", exitCode: 1, outputTruncated: false });
	});

	it("rejects a no-pull-request CLI error as a tool error instead of status failed", async () => {
		await expect(execute(operationsResult(1, 'no pull requests found for branch "ghost-branch"'))).rejects.toThrow(
			"could not query checks",
		);

		const operations = operationsResult(1, 'no pull requests found for branch "ghost-branch"');
		await expect(execute(operations)).rejects.toThrow("no pull requests found");
	});

	it.each([
		"GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)",
		"failed to run git: fatal: not a git repository",
		"HTTP 401: Bad credentials (https://api.github.com/graphql)",
		"could not parse the pull request selector",
	])("rejects CLI failure output %s as a tool error, not status failed", async (output) => {
		await expect(execute(operationsResult(1, output))).rejects.toThrow("could not query checks");
	});

	it("refuses to treat pending exit code 8 as terminal success", async () => {
		await expect(execute(operationsResult(8, "checks pending"))).rejects.toThrow(
			"checks were still pending (exit code 8)",
		);
	});

	it.each([null, 2, 4])("surfaces unexpected exit code %s loudly", async (exitCode) => {
		await expect(execute(operationsResult(exitCode, "gh diagnostic"))).rejects.toThrow("exited unexpectedly");
	});

	it("preserves buffered output when process execution fails", async () => {
		const operations: GithubCiOperations = {
			exec: vi.fn(async (_args, _cwd, { onData }) => {
				onData(Buffer.from("authentication required"));
				throw new Error("spawn failed");
			}),
		};

		await expect(execute(operations)).rejects.toThrow(
			"authentication required\n\nGitHub CI watch could not run: spawn failed",
		);
	});

	it("reports cancellation distinctly and forwards the AbortSignal", async () => {
		const controller = new AbortController();
		const operations: GithubCiOperations = {
			exec: vi.fn(async (_args, _cwd, { signal }) => {
				expect(signal).toBe(controller.signal);
				throw new Error("aborted");
			}),
		};

		await expect(execute(operations, {}, controller.signal)).rejects.toThrow("GitHub CI watch aborted");
	});

	it("streams watching updates and bounds retained output", async () => {
		const updates: any[] = [];
		const operations: GithubCiOperations = {
			exec: vi.fn(async (_args, _cwd, { onData }) => {
				onData(Buffer.from("x".repeat(DEFAULT_MAX_BYTES * 2)));
				onData(Buffer.from("y".repeat(DEFAULT_MAX_BYTES * 2)));
				return { exitCode: 0 };
			}),
		};
		const result = await execute(operations, {}, undefined, (update) => updates.push(update));

		expect(updates[0]).toEqual({
			content: [],
			details: { status: "watching", exitCode: undefined, outputTruncated: false },
		});
		expect(updates.at(-1).details.status).toBe("watching");
		expect(result.details?.outputTruncated).toBe(true);
		expect((result.content[0] as { text: string }).text.length).toBeLessThan(DEFAULT_MAX_BYTES + 500);
	});

	it("has prompt metadata that forbids wait and polling", () => {
		const tool = createWatchGithubCiToolDefinition("/repo", { operations: operationsResult(0) });
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
