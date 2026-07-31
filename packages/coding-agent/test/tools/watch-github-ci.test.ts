import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../src/core/tools/truncate.js";
import {
	createLocalGithubCiOperations,
	createWatchGithubCiToolDefinition,
	type GithubCiOperations,
} from "../../src/core/tools/watch-github-ci.js";

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

	afterEach(() => {
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
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
});
