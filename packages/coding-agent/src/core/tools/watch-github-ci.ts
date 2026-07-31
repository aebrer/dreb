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

function formatOutput(chunks: readonly Buffer[], omittedEarlierOutput: boolean): { text: string; truncated: boolean } {
	const rendered = renderTerminalOutput(Buffer.concat(chunks).toString("utf-8"));
	const truncation = truncateTail(rendered);
	const prefix = omittedEarlierOutput ? "[Earlier watch output omitted]\n" : "";
	return {
		text: `${prefix}${truncation.content || "(no output)"}`,
		truncated: omittedEarlierOutput || truncation.truncated,
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

			const args = ["pr", "checks", ...(selector ? [selector] : []), "--watch", "--fail-fast"];
			const chunks: Buffer[] = [];
			let chunksBytes = 0;
			let omittedEarlierOutput = false;
			let outputTruncated = false;
			const maxBufferedBytes = DEFAULT_MAX_BYTES * 2;

			const details = (status: WatchGithubCiToolDetails["status"], exitCode?: number) => ({
				status,
				exitCode,
				outputTruncated,
			});
			const currentOutput = (): string => {
				const formatted = formatOutput(chunks, omittedEarlierOutput);
				outputTruncated = formatted.truncated;
				return formatted.text;
			};
			const onData = (data: Buffer) => {
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
				onUpdate?.({
					content: [{ type: "text", text: currentOutput() }],
					details: details("watching"),
				});
			};

			onUpdate?.({ content: [], details: details("watching") });

			let exitCode: number | null;
			try {
				({ exitCode } = await operations.exec(args, cwd, {
					onData,
					signal,
					env: {
						...getShellEnv(),
						GH_PAGER: "cat",
						GH_EDITOR: "cat",
						NO_COLOR: "1",
					},
				}));
			} catch (error) {
				const output = chunks.length > 0 ? `${currentOutput()}\n\n` : "";
				if (error instanceof Error && error.message === "aborted") {
					throw new Error(`${output}GitHub CI watch aborted.`);
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${output}GitHub CI watch could not run: ${message}`);
			}

			const output = currentOutput();
			if (exitCode === 0) {
				return {
					content: [{ type: "text", text: `GitHub CI checks passed.\n\n${output}` }],
					details: details("passed", exitCode),
				};
			}
			if (exitCode === 1) {
				return {
					content: [
						{
							type: "text",
							text: `GitHub CI checks did not pass. The GitHub CLI exited with code 1.\n\n${output}`,
						},
					],
					details: details("failed", exitCode),
				};
			}
			if (exitCode === 8) {
				throw new Error(
					`GitHub CI watch exited while checks were still pending (exit code 8); refusing to treat this as a terminal result.\n\n${output}`,
				);
			}
			throw new Error(
				`GitHub CI watch exited unexpectedly${exitCode === null ? " without an exit code" : ` with code ${exitCode}`}.\n\n${output}`,
			);
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
