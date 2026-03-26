import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { attachJsonlLineReader } from "../../modes/rpc/jsonl.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";

// ---------------------------------------------------------------------------
// Agent type system
// ---------------------------------------------------------------------------

interface AgentTypeConfig {
	name: string;
	description: string;
	tools?: string;
	model?: string;
	systemPrompt: string;
}

const BUILTIN_AGENTS: Record<string, AgentTypeConfig> = {
	"general-purpose": {
		name: "general-purpose",
		description: "General-purpose agent with all tools. Inherits parent model.",
		systemPrompt: "",
	},
	Explore: {
		name: "Explore",
		description: "Fast codebase exploration — find files, search code, answer questions.",
		tools: "read,grep,find,ls,bash",
		systemPrompt:
			"You are a codebase exploration agent. Your job is to quickly find information in the codebase and report back concisely.\n\nRules:\n- Do NOT modify any files\n- Be thorough but concise in your findings\n- If you can't find what you're looking for, say so explicitly",
	},
};

function parseAgentFrontmatter(content: string): AgentTypeConfig | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return null;

	const frontmatter = fmMatch[1];
	const body = fmMatch[2].trim();

	const get = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match?.[1].trim();
	};

	const name = get("name");
	if (!name) return null;

	return {
		name,
		description: get("description") || "",
		tools: get("tools"),
		model: get("model"),
		systemPrompt: body,
	};
}

function discoverAgentTypes(cwd: string): Map<string, AgentTypeConfig> {
	const agents = new Map<string, AgentTypeConfig>();

	// Built-in agents as defaults
	for (const [key, config] of Object.entries(BUILTIN_AGENTS)) {
		agents.set(key, config);
	}

	// User-level agents (~/.dreb/agents/*.md)
	const userDir = join(homedir(), CONFIG_DIR_NAME, "agents");
	loadAgentsFromDir(userDir, agents);

	// Project-level agents (.dreb/agents/*.md)
	const projectDir = join(cwd, ".dreb", "agents");
	loadAgentsFromDir(projectDir, agents);

	return agents;
}

function loadAgentsFromDir(dir: string, agents: Map<string, AgentTypeConfig>): void {
	if (!existsSync(dir)) return;
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			try {
				const content = readFileSync(join(dir, file), "utf-8");
				const config = parseAgentFrontmatter(content);
				if (config) {
					agents.set(config.name, config);
				}
			} catch {
				// Skip unreadable agent files
			}
		}
	} catch {
		// Skip unreadable directory
	}
}

// ---------------------------------------------------------------------------
// Subagent process spawning
// ---------------------------------------------------------------------------

interface SubagentResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	errorMessage: string | null;
}

// Capture at module load before process.title overwrites argv memory on Linux.
// After process.title = "dreb" (in cli.ts), the original argv area is overwritten
// and process.argv[1] may return corrupted data in async contexts.
const DREB_SCRIPT = process.argv[1] || "dreb";
const NODE_EXEC = process.execPath;

function findDrebBinary(): string {
	return DREB_SCRIPT;
}

async function spawnSubagent(
	agentConfig: AgentTypeConfig,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
): Promise<SubagentResult> {
	const drebBin = findDrebBinary();

	// Validate cwd exists — spawn() throws a misleading ENOENT blaming the
	// binary when the cwd is invalid, making the real cause hard to diagnose
	if (!existsSync(cwd)) {
		return {
			agent: agentConfig.name,
			task,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: `Working directory does not exist: ${cwd}`,
		};
	}

	const args: string[] = ["--mode", "json", "--no-session"];
	if (agentConfig.model) {
		args.push("--model", agentConfig.model);
	}
	if (agentConfig.tools) {
		args.push("--tools", agentConfig.tools);
	}
	if (agentConfig.systemPrompt) {
		args.push("--append-system-prompt", agentConfig.systemPrompt);
	}
	args.push("-p", task);

	return new Promise<SubagentResult>((resolvePromise, rejectPromise) => {
		let proc: ChildProcess;
		try {
			proc = spawn(NODE_EXEC, [drebBin, ...args], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});
		} catch (err) {
			rejectPromise(new Error(`Failed to spawn subagent: ${err instanceof Error ? err.message : String(err)}`));
			return;
		}

		const collectedMessages: Array<{ role: string; content: any[] }> = [];
		let stderrChunks: string[] = [];
		let lastToolName = "";

		// Drain stderr concurrently to avoid pipe deadlock
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk.toString());
		});

		// Parse JSONL events from stdout
		if (proc.stdout) {
			attachJsonlLineReader(proc.stdout, (line) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						collectedMessages.push(event.message);
					}
					// Progress reporting
					if (event.type === "tool_execution_start" && onProgress) {
						lastToolName = event.toolName || "";
						onProgress(`Using ${lastToolName}...`);
					}
					if (event.type === "tool_execution_end" && onProgress) {
						onProgress(`${lastToolName} done`);
					}
				} catch {
					// Ignore unparseable lines (e.g. session header)
				}
			});
		}

		// Handle abort signal
		const onAbort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(new Error(`Subagent process error: ${err.message}`));
		});

		proc.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			const exitCode = code ?? 1;
			const stderr = stderrChunks.join("");

			// Extract final text output from collected assistant messages
			const outputParts: string[] = [];
			for (const msg of collectedMessages) {
				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							outputParts.push(part.text);
						}
					}
				}
			}
			const output = outputParts.join("\n\n");

			resolvePromise({
				agent: agentConfig.name,
				task,
				exitCode,
				output,
				stderr: stderr.slice(0, 2000), // cap stderr
				errorMessage: exitCode !== 0 ? (stderr.trim().slice(0, 500) || `Subagent exited with code ${exitCode}`) : null,
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Execution modes
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

async function executeSingle(
	agents: Map<string, AgentTypeConfig>,
	agentName: string | undefined,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
): Promise<SubagentResult> {
	const name = agentName || "general-purpose";
	const config = agents.get(name);
	if (!config) {
		return {
			agent: name,
			task,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: `Unknown agent type "${name}". Available: ${[...agents.keys()].join(", ")}`,
		};
	}
	onProgress?.(`Running ${name} agent...`);
	return spawnSubagent(config, task, cwd, signal, onProgress);
}

async function executeParallel(
	agents: Map<string, AgentTypeConfig>,
	tasks: Array<{ agent?: string; task: string; cwd?: string }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
): Promise<SubagentResult[]> {
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return [
			{
				agent: "",
				task: "",
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: `Too many tasks: ${tasks.length} (max ${MAX_PARALLEL_TASKS})`,
			},
		];
	}

	const results: SubagentResult[] = [];
	let completed = 0;
	let running = 0;

	// Simple semaphore via queue
	const queue = [...tasks];
	const promises: Promise<void>[] = [];

	const runNext = async (): Promise<void> => {
		while (queue.length > 0) {
			if (signal?.aborted) return;
			const item = queue.shift()!;
			running++;
			const result = await executeSingle(
				agents,
				item.agent,
				item.task,
				item.cwd ? resolve(defaultCwd, item.cwd) : defaultCwd,
				signal,
			);
			results.push(result);
			running--;
			completed++;
			onProgress?.(`${completed}/${tasks.length} complete`);
		}
	};

	// Launch up to MAX_CONCURRENCY workers
	const workerCount = Math.min(MAX_CONCURRENCY, tasks.length);
	for (let i = 0; i < workerCount; i++) {
		promises.push(runNext());
	}
	await Promise.all(promises);

	return results;
}

async function executeChain(
	agents: Map<string, AgentTypeConfig>,
	chain: Array<{ agent?: string; task: string; cwd?: string }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
): Promise<SubagentResult[]> {
	const results: SubagentResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		if (signal?.aborted) break;
		const step = chain[i];
		const task = step.task.replace(/\{previous\}/g, previousOutput);
		onProgress?.(`Chain step ${i + 1}/${chain.length}`);

		const result = await executeSingle(
			agents,
			step.agent,
			task,
			step.cwd ? resolve(defaultCwd, step.cwd) : defaultCwd,
			signal,
		);
		results.push(result);

		if (result.exitCode !== 0) {
			break; // stop chain on error
		}
		previousOutput = result.output;
	}

	return results;
}

// ---------------------------------------------------------------------------
// Background execution
// ---------------------------------------------------------------------------

function generateAgentId(): string {
	return randomBytes(6).toString("hex");
}

// Track running background agents for cleanup on abort
const backgroundAgents = new Map<string, ChildProcess>();

export interface SubagentToolOptions {
	/**
	 * Called when a background subagent completes. The caller should inject the
	 * result as a follow-up message into the agent conversation.
	 */
	onBackgroundComplete?: (agentId: string, result: SubagentResult) => void;
}

// ---------------------------------------------------------------------------
// Tool schema and definition
// ---------------------------------------------------------------------------

const taskItemSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (e.g. 'Explore', 'general-purpose')" })),
	task: Type.String({ description: "The task prompt for this subagent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory (defaults to parent's cwd)" })),
});

const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (default: 'general-purpose')" })),
	task: Type.Optional(Type.String({ description: "Task prompt (single mode)" })),
	tasks: Type.Optional(Type.Array(taskItemSchema, { description: "Array of tasks to run in parallel (max 8)" })),
	chain: Type.Optional(
		Type.Array(taskItemSchema, {
			description: "Sequential pipeline — each step can use {previous} for prior output",
		}),
	),
	background: Type.Optional(
		Type.Boolean({ description: "Run in background — returns immediately, notifies on completion" }),
	),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

export interface SubagentToolDetails {
	truncation?: TruncationResult;
	mode: "single" | "parallel" | "chain";
	agentCount: number;
}

function formatSubagentCall(
	args: SubagentToolInput | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);

	if (args?.tasks) {
		return (
			theme.fg("toolTitle", theme.bold("subagent")) +
			" " +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`)
		);
	}
	if (args?.chain) {
		return (
			theme.fg("toolTitle", theme.bold("subagent")) +
			" " +
			theme.fg("accent", `chain (${args.chain.length} steps)`)
		);
	}

	const agent = str(args?.agent) || "general-purpose";
	const task = str(args?.task);
	const taskPreview = task ? (task.length > 60 ? task.slice(0, 57) + "..." : task) : null;
	return (
		theme.fg("toolTitle", theme.bold("subagent")) +
		" " +
		theme.fg("accent", agent) +
		" " +
		(taskPreview === null ? invalidArg : theme.fg("toolOutput", `"${taskPreview}"`))
	);
}

function formatSubagentResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: SubagentToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 25;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
}

function formatSingleResult(result: SubagentResult): string {
	let text = `## Agent: ${result.agent}\n`;
	if (result.exitCode !== 0) {
		text += `**Error** (exit ${result.exitCode}): ${result.errorMessage || "Unknown error"}\n`;
		if (result.stderr) {
			text += `\nStderr:\n${result.stderr}\n`;
		}
	}
	if (result.output) {
		text += `\n${result.output}`;
	} else if (result.exitCode === 0) {
		text += "\n(No output)";
	}
	return text;
}

export function createSubagentToolDefinition(
	cwd: string,
	options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails | undefined> {
	const onBackgroundComplete = options?.onBackgroundComplete;

	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate tasks to specialized subagents that run independently. " +
			"Supports single task, parallel (up to 8, max 4 concurrent), " +
			"and chain (sequential pipeline with {previous} substitution) modes. " +
			"Set background=true to return immediately and get notified on completion.",
		promptSnippet: "Delegate tasks to independent subagents (supports background execution)",
		promptGuidelines: [
			"Use `subagent` to delegate focused, independent tasks to child agents",
			"Available agent types can be discovered from ~/.dreb/agents/ and .dreb/agents/ markdown files",
			"Built-in agents: 'general-purpose' (all tools, default) and 'Explore' (read-only, fast research)",
			"Use parallel mode for independent tasks that can run concurrently",
			"Use chain mode when each step depends on the previous step's output (reference with {previous})",
			"Set background=true to fire-and-forget — you'll be notified when the agent completes",
			"Subagents have their own context window — provide enough context in the task prompt",
		],
		parameters: subagentSchema,

		async execute(_toolCallId, params: SubagentToolInput, signal, onUpdate) {
			const agents = discoverAgentTypes(cwd);

			// Determine mode
			const modeCount =
				(params.task ? 1 : 0) + (params.tasks ? 1 : 0) + (params.chain ? 1 : 0);
			if (modeCount === 0) {
				return {
					content: [{ type: "text", text: "Error: provide one of `task` (single), `tasks` (parallel), or `chain`." }],
					details: undefined,
				};
			}
			if (modeCount > 1) {
				return {
					content: [
						{ type: "text", text: "Error: modes are mutually exclusive — provide only one of `task`, `tasks`, or `chain`." },
					],
					details: undefined,
				};
			}

			// Background mode: spawn and return immediately
			if (params.background) {
				if (!onBackgroundComplete) {
					return {
						content: [{ type: "text", text: "Background execution not available in this context (no completion handler registered)." }],
						details: undefined,
					};
				}

				const agentId = generateAgentId();
				const agentName = params.agent || "general-purpose";
				const taskSummary = params.task
					? `single task for ${agentName}`
					: params.tasks
						? `${params.tasks.length} parallel tasks`
						: `${params.chain!.length}-step chain`;

				// Fire off the work asynchronously — don't await
				const runBackground = async () => {
					try {
						let result: SubagentResult;
						if (params.task) {
							result = await executeSingle(agents, params.agent, params.task, cwd);
						} else if (params.tasks) {
							const results = await executeParallel(agents, params.tasks, cwd);
							const resultText = results.map((r, i) => `### Task ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
							const failed = results.filter((r) => r.exitCode !== 0);
							result = {
								agent: "parallel",
								task: taskSummary,
								exitCode: failed.length > 0 ? 1 : 0,
								output: resultText,
								stderr: "",
								errorMessage: failed.length > 0 ? `${failed.length} of ${results.length} tasks failed` : null,
							};
						} else {
							const results = await executeChain(agents, params.chain!, cwd);
							const resultText = results.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
							const failed = results.filter((r) => r.exitCode !== 0);
							result = {
								agent: "chain",
								task: taskSummary,
								exitCode: failed.length > 0 ? 1 : 0,
								output: resultText,
								stderr: "",
								errorMessage: failed.length > 0 ? `Chain stopped: step ${results.length} failed` : null,
							};
						}
						onBackgroundComplete(agentId, result);
					} catch (err) {
						onBackgroundComplete(agentId, {
							agent: params.agent || "general-purpose",
							task: params.task || taskSummary,
							exitCode: 1,
							output: "",
							stderr: "",
							errorMessage: err instanceof Error ? err.message : String(err),
						});
					}
				};
				runBackground();

				return {
					content: [
						{
							type: "text",
							text: `Background agent ${agentId} started (${taskSummary}). You will be notified when it completes.`,
						},
					],
					details: { mode: "single", agentCount: 1 } as SubagentToolDetails,
				};
			}

			// Foreground mode: run and wait for results
			const progressCallback = onUpdate
				? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }] } as any)
				: undefined;

			let resultText: string;
			let details: SubagentToolDetails;

			if (params.task) {
				const result = await executeSingle(agents, params.agent, params.task, cwd, signal ?? undefined, progressCallback);
				resultText = formatSingleResult(result);
				details = { mode: "single", agentCount: 1 };
			} else if (params.tasks) {
				const results = await executeParallel(agents, params.tasks, cwd, signal ?? undefined, progressCallback);
				resultText = results.map((r, i) => `### Task ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
				details = { mode: "parallel", agentCount: params.tasks.length };
			} else {
				const results = await executeChain(agents, params.chain!, cwd, signal ?? undefined, progressCallback);
				resultText = results.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
				details = { mode: "chain", agentCount: params.chain!.length };
			}

			const truncation = truncateHead(resultText, { maxLines: Number.MAX_SAFE_INTEGER });
			if (truncation.truncated) {
				details.truncation = truncation;
			}

			return {
				content: [{ type: "text", text: truncation.content }],
				details: Object.keys(details).length > 1 ? details : undefined,
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSubagentCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSubagentResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createSubagentTool(cwd: string, options?: SubagentToolOptions): AgentTool<typeof subagentSchema> {
	return wrapToolDefinition(createSubagentToolDefinition(cwd, options));
}

export const subagentToolDefinition = createSubagentToolDefinition(process.cwd());
export const subagentTool = createSubagentTool(process.cwd());
