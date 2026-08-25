import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentTool } from "@dreb/agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { waitForChildProcess } from "../../utils/child-process.js";
import { getShellEnv, killProcessTree } from "../../utils/shell.js";
import type { ToolDefinition } from "../extensions/types.js";
import { renderTerminalOutput } from "./terminal-render.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.js";

const watchGithubCiSchema = Type.Object({
	pr: Type.Optional(
		Type.String({
			description:
				"Optional pull request number, URL, or branch. Omit to use the pull request for the current branch.",
		}),
	),
});

export type WatchGithubCiToolInput = Static<typeof watchGithubCiSchema>;

export interface WatchGithubCiToolDetails {
	status: "watching" | "passed" | "failed";
	exitCode?: number;
	outputTruncated: boolean;
}

export interface GithubCiOperations {
	exec: (
		args: readonly string[],
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			env: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface WatchGithubCiToolOptions {
	operations?: GithubCiOperations;
}

/**
 * Substrings (matched case-insensitively) that identify a `gh pr checks` CLI-level
 * failure rather than a real failed-check result. `gh pr checks` exits 1 for both,
 * and `--json` is incompatible with `--watch`, so the captured output is the only
 * way to tell them apart. These signatures are specific enough that they will not
 * appear in a normal check-status table.
 */
const GH_CLI_FAILURE_SIGNATURES = [
	"no pull requests found",
	"could not resolve to a pullrequest",
	"failed to run git",
	"not a git repository",
	"http 401",
	"bad credentials",
	"could not parse",
	"invalid pull request",
	"authentication required",
	"could not find repository",
];

function detectGhCliFailure(output: string): string | null {
	const lower = output.toLowerCase();
	for (const signature of GH_CLI_FAILURE_SIGNATURES) {
		if (lower.includes(signature)) {
			return signature;
		}
	}
	return null;
}

export function createLocalGithubCiOperations(): GithubCiOperations {
	return {
		exec: (args, cwd, { onData, signal, env }) =>
			new Promise((resolve, reject) => {
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}`));
					return;
				}
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				const child = spawn("gh", [...args], {
					cwd,
					detached: true,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				waitForChildProcess(child)
					.then((exitCode) => {
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						resolve({ exitCode });
					})
					.catch((error) => {
						signal?.removeEventListener("abort", onAbort);
						reject(error);
					});
			}),
	};
}

interface OutputBuffer {
	append(data: Buffer): void;
	format(): { text: string; truncated: boolean };
	hasOutput(): boolean;
}

function createOutputBuffer(omittedPrefix: string): OutputBuffer {
	const chunks: Buffer[] = [];
	let chunksBytes = 0;
	let omittedEarlierOutput = false;
	const maxBufferedBytes = DEFAULT_MAX_BYTES * 2;

	return {
		append(data) {
			chunks.push(data);
			chunksBytes += data.length;
			while (chunksBytes > maxBufferedBytes) {
				const excess = chunksBytes - maxBufferedBytes;
				const first = chunks[0];
				if (first.length <= excess) {
					chunks.shift();
					chunksBytes -= first.length;
				} else {
					chunks[0] = first.subarray(excess);
					chunksBytes -= excess;
				}
				omittedEarlierOutput = true;
			}
		},
		format() {
			const rendered = renderTerminalOutput(Buffer.concat(chunks).toString("utf-8"));
			const truncation = truncateTail(rendered);
			const prefix = omittedEarlierOutput ? `${omittedPrefix}\n` : "";
			return {
				text: `${prefix}${truncation.content || "(no output)"}`,
				truncated: omittedEarlierOutput || truncation.truncated,
			};
		},
		hasOutput() {
			return chunks.length > 0;
		},
	};
}

export function createWatchGithubCiToolDefinition(
	cwd: string,
	options?: WatchGithubCiToolOptions,
): ToolDefinition<typeof watchGithubCiSchema, WatchGithubCiToolDetails> {
	const operations = options?.operations ?? createLocalGithubCiOperations();

	return {
		name: "watch_github_ci",
		label: "watch GitHub CI",
		description:
			"Watch GitHub pull-request checks until they pass or fail. Uses the current branch's pull request by default, or an optional pull request number, URL, or branch. Returns the final GitHub CLI output without requiring user input.",
		promptSnippet: "Watch GitHub pull-request CI until checks pass or fail",
		promptGuidelines: [
			"Use `watch_github_ci` to wait for GitHub pull-request checks instead of asking the user, polling with repeated commands, sleeping, or using `wait`",
			"`watch_github_ci` blocks until the selected pull request's checks pass or fail; omit `pr` to use the current branch's pull request",
		],
		parameters: watchGithubCiSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const selector = params.pr?.trim();
			if (params.pr !== undefined && !selector) {
				throw new Error("Pull request selector must not be blank.");
			}
			if (selector?.startsWith("-")) {
				throw new Error("Pull request selector must not begin with '-'.");
			}

			const watchArgs = ["pr", "checks", ...(selector ? [selector] : []), "--watch", "--fail-fast"];
			const finalArgs = ["pr", "checks", ...(selector ? [selector] : [])];
			const env = {
				...getShellEnv(),
				GH_PAGER: "cat",
				GH_EDITOR: "cat",
				NO_COLOR: "1",
			};
			const details = (status: WatchGithubCiToolDetails["status"], outputTruncated: boolean, exitCode?: number) => ({
				status,
				exitCode,
				outputTruncated,
			});

			const watchOutput = createOutputBuffer("[Earlier watch output omitted]");
			const onWatchData = (data: Buffer) => {
				watchOutput.append(data);
				const formatted = watchOutput.format();
				onUpdate?.({
					content: [{ type: "text", text: formatted.text }],
					details: details("watching", formatted.truncated),
				});
			};

			onUpdate?.({ content: [], details: details("watching", false) });

			let watchExitCode: number | null;
			try {
				({ exitCode: watchExitCode } = await operations.exec(watchArgs, cwd, {
					onData: onWatchData,
					signal,
					env,
				}));
			} catch (error) {
				const output = watchOutput.hasOutput() ? `${watchOutput.format().text}\n\n` : "";
				if (error instanceof Error && error.message === "aborted") {
					throw new Error(`${output}GitHub CI watch aborted.`);
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${output}GitHub CI watch could not run: ${message}`);
			}

			const formattedWatchOutput = watchOutput.format();
			if (watchExitCode === 1) {
				const cliFailure = detectGhCliFailure(formattedWatchOutput.text);
				if (cliFailure !== null) {
					throw new Error(
						`GitHub CI watch could not query checks: the GitHub CLI reported an error (matched "${cliFailure}"). This is a CLI-level failure such as a bad pull-request selector, no pull request for the branch, a missing repository, or an authentication problem — not a failed-check result. Re-check the selector and \`gh auth status\`.\n\n${formattedWatchOutput.text}`,
					);
				}
			} else if (watchExitCode === 8) {
				throw new Error(
					`GitHub CI watch exited while checks were still pending (exit code 8); refusing to treat this as a terminal result.\n\n${formattedWatchOutput.text}`,
				);
			} else if (watchExitCode !== 0) {
				throw new Error(
					`GitHub CI watch exited unexpectedly${watchExitCode === null ? " without an exit code" : ` with code ${watchExitCode}`}.\n\n${formattedWatchOutput.text}`,
				);
			}

			const finalOutput = createOutputBuffer("[Earlier final checks output omitted]");
			let finalExitCode: number | null;
			try {
				({ exitCode: finalExitCode } = await operations.exec(finalArgs, cwd, {
					onData: (data) => finalOutput.append(data),
					signal,
					env,
				}));
			} catch (error) {
				const output = finalOutput.hasOutput() ? `${finalOutput.format().text}\n\n` : "";
				if (error instanceof Error && error.message === "aborted") {
					throw new Error(`${output}GitHub CI final checks query aborted.`);
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${output}GitHub CI final checks query could not run: ${message}`);
			}

			const formattedFinalOutput = finalOutput.format();
			if (finalExitCode === 1) {
				const cliFailure = detectGhCliFailure(formattedFinalOutput.text);
				if (cliFailure !== null) {
					throw new Error(
						`GitHub CI final checks query failed: the GitHub CLI reported an error (matched "${cliFailure}"). Re-check the selector and \`gh auth status\`.\n\n${formattedFinalOutput.text}`,
					);
				}
			} else if (finalExitCode === 8) {
				throw new Error(
					`GitHub CI final checks query found checks still pending (exit code 8) after the watch reported a terminal result.\n\n${formattedFinalOutput.text}`,
				);
			} else if (finalExitCode !== 0) {
				throw new Error(
					`GitHub CI final checks query exited unexpectedly${finalExitCode === null ? " without an exit code" : ` with code ${finalExitCode}`}.\n\n${formattedFinalOutput.text}`,
				);
			}

			if (watchExitCode !== finalExitCode) {
				throw new Error(
					`GitHub CI status changed between watch completion (exit code ${watchExitCode}) and the final checks query (exit code ${finalExitCode}); refusing to report a contradictory result.\n\n${formattedFinalOutput.text}`,
				);
			}

			if (finalExitCode === 0) {
				return {
					content: [{ type: "text", text: `GitHub CI checks passed.\n\n${formattedFinalOutput.text}` }],
					details: details("passed", formattedFinalOutput.truncated, finalExitCode),
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `GitHub CI checks did not pass. The GitHub CLI exited with code 1.\n\n${formattedFinalOutput.text}`,
					},
				],
				details: details("failed", formattedFinalOutput.truncated, finalExitCode),
			};
		},
	};
}

export function createWatchGithubCiTool(
	cwd: string,
	options?: WatchGithubCiToolOptions,
): AgentTool<typeof watchGithubCiSchema> {
	return wrapToolDefinition(createWatchGithubCiToolDefinition(cwd, options));
}

export const watchGithubCiToolDefinition = createWatchGithubCiToolDefinition(process.cwd());
export const watchGithubCiTool = createWatchGithubCiTool(process.cwd());
