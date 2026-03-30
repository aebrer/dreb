import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME, getPackageDir } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { attachJsonlLineReader } from "../../modes/rpc/jsonl.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";
import { resolveCliModel } from "../model-resolver.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

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

const DEFAULT_AGENT = "Explore";

const BUILTIN_AGENTS: Record<string, AgentTypeConfig> = {
	Explore: {
		name: "Explore",
		description: "Codebase exploration — find files, search code, answer questions. Read-only.",
		tools: "read,grep,find,ls,bash",
		systemPrompt:
			"You are a codebase exploration agent. Your job is to quickly find information in the codebase and report back concisely.\n\nRules:\n- Do NOT modify any files\n- Be thorough but concise in your findings\n- If you can't find what you're looking for, say so explicitly",
	},
	Sandbox: {
		name: "Sandbox",
		description: "Sandboxed analysis agent restricted to /tmp files only (no codebase access).",
		tools: "read",
		systemPrompt:
			"You are a sandboxed analysis agent. You have NO access to the project codebase.\n\nRules:\n- You can ONLY read files under /tmp/\n- Do NOT attempt to access any files outside /tmp/\n- All input data will be provided in the task prompt or in /tmp/ files\n- Analyze, summarize, and reason about the data you are given",
	},
};

function parseAgentFrontmatter(content: string): { ok: true; config: AgentTypeConfig } | { ok: false; error: string } {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return { ok: false, error: "missing --- frontmatter delimiters" };

	const frontmatter = fmMatch[1];
	const body = fmMatch[2].trim();

	const get = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match?.[1].trim();
	};

	const name = get("name");
	if (!name) return { ok: false, error: "missing required 'name' field in frontmatter" };

	return {
		ok: true,
		config: {
			name,
			description: get("description") || "",
			tools: get("tools"),
			model: get("model"),
			systemPrompt: body,
		},
	};
}

function discoverAgentTypes(cwd: string): Map<string, AgentTypeConfig> {
	const agents = new Map<string, AgentTypeConfig>();

	// Built-in agents as defaults
	for (const [key, config] of Object.entries(BUILTIN_AGENTS)) {
		agents.set(key, config);
	}

	// Package-bundled agents (shipped with dreb — overrides hardcoded defaults, but overridden by user/project agents)
	const packageAgentsDir = join(getPackageDir(), "agents");
	loadAgentsFromDir(packageAgentsDir, agents);

	// User-level agents (~/.dreb/agents/*.md)
	const userDir = join(homedir(), CONFIG_DIR_NAME, "agents");
	loadAgentsFromDir(userDir, agents);

	// Project-level agents (.dreb/agents/*.md)
	// TODO: Security gate — prompt user for confirmation before loading agents from untrusted repos
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
				const parsed = parseAgentFrontmatter(content);
				if (!parsed.ok) {
					console.error(`[subagent] Skipping agent file ${join(dir, file)}: ${parsed.error}`);
				} else {
					agents.set(parsed.config.name, parsed.config);
				}
			} catch (err) {
				console.error(
					`[subagent] Could not read agent file ${join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(
				`[subagent] Could not read agents directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Subagent process spawning
// ---------------------------------------------------------------------------

export interface SubagentResult {
	agent: string;
	task: string;
	model?: string;
	exitCode: number;
	output: string;
	stderr: string;
	errorMessage: string | null;
}

// Capture at module load before process.title overwrites argv memory on Linux.
// After process.title = "dreb" (in cli.ts), the original argv area is overwritten
// and process.argv[1] may return corrupted or truncated data.
const DREB_SCRIPT = process.argv[1] || "dreb";
const NODE_EXEC = process.execPath;

// TODO: Support PATH-based binary discovery.
// Currently returns the captured argv[1].
function findDrebBinary(): string {
	return DREB_SCRIPT;
}

async function spawnSubagent(
	agentConfig: AgentTypeConfig,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
): Promise<SubagentResult> {
	const drebBin = findDrebBinary();
	console.error(`[subagent] spawn: agent=${agentConfig.name} cwd=${cwd}`);

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
		// When the model string doesn't already specify a provider (no "/"),
		// inherit the parent's provider to prevent fuzzy matching from picking
		// an unauthenticated provider (e.g. Bedrock instead of Anthropic).
		if (parentProvider && !agentConfig.model.includes("/")) {
			args.push("--provider", parentProvider);
		}
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

		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		const collectedMessages: Array<{ role: string; content: any[] }> = [];
		const stderrChunks: string[] = [];
		let stderrSize = 0;
		const MAX_STDERR_BYTES = 8192;
		const plainStdoutLines: string[] = [];
		let lastToolName = "";
		let resolvedModel: string | undefined;

		// Drain stderr concurrently to avoid pipe deadlock (capped to prevent OOM from verbose subagents)
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrSize < MAX_STDERR_BYTES) {
				const str = chunk.toString();
				stderrChunks.push(str);
				stderrSize += str.length;
			}
		});
		proc.stderr?.on("error", (err) => {
			console.error(`[subagent] stderr stream error (agent=${agentConfig.name}): ${err.message}`);
		});

		// Parse JSONL events from stdout
		if (proc.stdout) {
			proc.stdout.on("error", (err) => {
				console.error(`[subagent] stdout stream error (agent=${agentConfig.name}): ${err.message}`);
			});
			attachJsonlLineReader(proc.stdout, (line) => {
				if (!line.trim()) return;
				// Separate JSON.parse from event handling so only parse failures
				// are caught as non-JSON lines — errors in handling propagate normally
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					// Capture non-JSON lines — on failure these often contain the real error
					// (e.g. startup errors printed before JSONL mode begins)
					plainStdoutLines.push(line.trim());
					if (line.trim().startsWith("{")) {
						console.error(`[subagent] Failed to parse JSONL event: ${line.slice(0, 200)}`);
					}
					return;
				}
				if (event.type === "agent_start" && event.model) {
					resolvedModel = event.model.id;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					collectedMessages.push(event.message);
				}
				if (event.type === "tool_execution_start" && onProgress) {
					lastToolName = event.toolName || "";
					onProgress(`Using ${lastToolName}...`);
				}
				if (event.type === "tool_execution_end" && onProgress) {
					onProgress(`${lastToolName} done`);
				}
			});
		}

		// Handle abort signal (guard kill() against ESRCH race if process already exited)
		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* process already exited */
			}
			killTimer = setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* process already exited */
				}
			}, 5000);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(new Error(`Subagent process error: ${err.message}`));
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			const exitCode = code ?? 1;
			const stderr = stderrChunks.join("");
			console.error(
				`[subagent] close: agent=${agentConfig.name} exit=${exitCode} messages=${collectedMessages.length}${exitCode !== 0 ? ` stderr=${stderr.slice(0, 200)} stdout=${plainStdoutLines.join("|").slice(0, 200)}` : ""}`,
			);

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

			// Build error message from best available source: stderr, plain stdout lines, or generic
			let errorMessage: string | null = null;
			if (exitCode !== 0) {
				const stderrTrimmed = stderr.trim();
				const plainOutput = plainStdoutLines.join("\n").trim();
				errorMessage =
					stderrTrimmed.slice(0, 500) || plainOutput.slice(0, 500) || `Subagent exited with code ${exitCode}`;
			}

			resolvePromise({
				agent: agentConfig.name,
				task,
				model: resolvedModel ?? (exitCode === 0 ? agentConfig.model : undefined),
				exitCode,
				output,
				stderr: stderr.slice(0, 2000), // cap stderr
				errorMessage,
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Execution modes
// ---------------------------------------------------------------------------

/**
 * Resolve a model string against the registry. Returns the canonical model ID
 * on success, or an error string on failure. When no modelRegistry is available,
 * passes the string through unvalidated (backward compat).
 */
function resolveModelString(
	modelStr: string,
	parentProvider: string | undefined,
	registry: ModelRegistry | undefined,
): { ok: true; modelId: string; provider?: string } | { ok: false; error: string } {
	if (!registry) {
		return { ok: true, modelId: modelStr };
	}

	// If the model string contains "/" the user already specified a provider
	const hasProvider = modelStr.includes("/");
	const resolved = resolveCliModel({
		cliProvider: hasProvider ? undefined : parentProvider,
		cliModel: modelStr,
		modelRegistry: registry,
	});

	if (resolved.error) {
		return { ok: false, error: resolved.error };
	}
	if (!resolved.model) {
		return { ok: false, error: `Model "${modelStr}" not found. Use --list-models to see available models.` };
	}

	// FRAGILE: This string must match the warning text in model-resolver.ts
	// buildFallbackModel path (line ~446). resolveCliModel creates a synthetic
	// model for any unknown ID when a provider is specified (designed for
	// custom/self-hosted models like Ollama). For subagents this causes silent
	// failures — reject it.
	// TODO: Replace with a structured flag like `isSyntheticFallback` on ResolveCliModelResult.
	if (resolved.warning?.includes("Using custom model id.")) {
		return {
			ok: false,
			error: `Model "${modelStr}" not found for provider "${resolved.model.provider}". Use --list-models to see available models.`,
		};
	}

	return { ok: true, modelId: resolved.model.id, provider: resolved.model.provider };
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_TASK_LENGTH = 32_768; // 32 KB — prevent E2BIG from oversized argv

// Semaphore for background task concurrency — shared across all background launches
let bgRunning = 0;
const bgWaiters: Array<() => void> = [];

async function bgAcquire(): Promise<void> {
	if (bgRunning < MAX_CONCURRENCY) {
		bgRunning++;
		return;
	}
	return new Promise<void>((resolve) => {
		bgWaiters.push(() => {
			bgRunning++;
			resolve();
		});
	});
}

function bgRelease(): void {
	bgRunning--;
	const next = bgWaiters.shift();
	if (next) next();
}

/**
 * Resolve a per-task cwd relative to the parent cwd.
 * Rejects absolute paths and relative paths that escape the parent directory.
 * Returns a result object with ok=false and an error string on rejection, so callers can surface it to the model.
 */
function clampCwd(defaultCwd: string, itemCwd?: string): { ok: true; cwd: string } | { ok: false; error: string } {
	if (!itemCwd) return { ok: true, cwd: defaultCwd };
	if (itemCwd.startsWith("/")) {
		return { ok: false, error: `Rejected absolute cwd "${itemCwd}" — must be relative to parent cwd` };
	}
	const resolved = resolve(defaultCwd, itemCwd);
	if (resolved !== defaultCwd && !resolved.startsWith(`${defaultCwd}/`)) {
		return { ok: false, error: `Rejected cwd "${itemCwd}" — resolves outside parent cwd` };
	}
	return { ok: true, cwd: resolved };
}

async function executeSingle(
	agents: Map<string, AgentTypeConfig>,
	agentName: string | undefined,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	modelOverride?: string,
	parentProvider?: string,
	registry?: ModelRegistry,
): Promise<SubagentResult> {
	const name = agentName || DEFAULT_AGENT;
	const config = agents.get(name);
	if (!config) {
		return {
			agent: name,
			task,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: `Unknown agent type "${name}". Available: ${[...agents.keys()].join(", ")}. If you expected "${name}" to exist, check the .md file in ~/.dreb/agents/ or .dreb/agents/ for syntax errors.`,
		};
	}
	// Validate task length for all modes (single, parallel items, chain steps)
	if (task.length > MAX_TASK_LENGTH) {
		return {
			agent: name,
			task: `${task.slice(0, 200)}...`,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: `Task prompt too long (${task.length} chars, max ${MAX_TASK_LENGTH}). Shorten the prompt.`,
		};
	}
	// Per-invocation model override takes precedence over agent definition model
	const modelStr = modelOverride || config.model;
	let effectiveConfig = modelOverride ? { ...config, model: modelOverride } : config;
	let resolvedProvider = parentProvider;

	// Resolve and validate the model string against the registry before spawning.
	// This catches typos and invalid model names immediately instead of failing
	// silently in the child process. Also passes the canonical model ID to the
	// child, avoiding fuzzy matching entirely.
	if (modelStr) {
		const resolved = resolveModelString(modelStr, parentProvider, registry);
		if (!resolved.ok) {
			return {
				agent: name,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: resolved.error,
			};
		}
		effectiveConfig = { ...effectiveConfig, model: resolved.modelId };
		if (resolved.provider) {
			resolvedProvider = resolved.provider;
		}
	}

	onProgress?.(`Running ${name} agent...`);
	return spawnSubagent(effectiveConfig, task, cwd, signal, onProgress, resolvedProvider);
}

async function executeParallel(
	agents: Map<string, AgentTypeConfig>,
	tasks: Array<{ agent?: string; task: string; cwd?: string; model?: string }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
	registry?: ModelRegistry,
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

	const results: (SubagentResult | undefined)[] = new Array(tasks.length);
	let completed = 0;

	// Worker-pool pattern: spawn up to MAX_CONCURRENCY async workers, each pulling from the shared queue
	const queue = tasks.map((item, index) => ({ item, index }));
	const promises: Promise<void>[] = [];

	const runNext = async (): Promise<void> => {
		while (queue.length > 0) {
			if (signal?.aborted) {
				// Fill remaining slots with cancellation results so callers never see undefined
				while (queue.length > 0) {
					const remaining = queue.shift()!;
					results[remaining.index] = {
						agent: remaining.item.agent || DEFAULT_AGENT,
						task: remaining.item.task,
						exitCode: 1,
						output: "",
						stderr: "",
						errorMessage: "Cancelled before execution started",
					};
				}
				return;
			}
			const entry = queue.shift()!;
			const { item, index } = entry;
			const cwdResult = clampCwd(defaultCwd, item.cwd);
			let result: SubagentResult;
			if (!cwdResult.ok) {
				result = {
					agent: item.agent || DEFAULT_AGENT,
					task: item.task,
					exitCode: 1,
					output: "",
					stderr: "",
					errorMessage: cwdResult.error,
				};
			} else {
				try {
					result = await executeSingle(
						agents,
						item.agent,
						item.task,
						cwdResult.cwd,
						signal,
						onProgress,
						item.model,
						parentProvider,
						registry,
					);
				} catch (err) {
					result = {
						agent: item.agent || DEFAULT_AGENT,
						task: item.task,
						exitCode: 1,
						output: "",
						stderr: "",
						errorMessage: `Subagent spawn failed: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			}
			results[index] = result;
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

	return results as SubagentResult[];
}

async function executeChain(
	agents: Map<string, AgentTypeConfig>,
	chain: Array<{ agent?: string; task: string; cwd?: string; model?: string }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
	registry?: ModelRegistry,
): Promise<SubagentResult[]> {
	const results: SubagentResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		if (signal?.aborted) break;
		const step = chain[i];
		const task = step.task.replace(/\{previous\}/g, previousOutput);
		onProgress?.(`Chain step ${i + 1}/${chain.length}`);

		// Validate task length after {previous} substitution (can compound across steps)
		if (task.length > MAX_TASK_LENGTH) {
			results.push({
				agent: step.agent || DEFAULT_AGENT,
				task: `${task.slice(0, 200)}...`,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: `Task prompt too long after {previous} substitution (${task.length} chars, max ${MAX_TASK_LENGTH}). Shorten the prompt or summarize previous output.`,
			});
			break;
		}

		const cwdResult = clampCwd(defaultCwd, step.cwd);
		if (!cwdResult.ok) {
			results.push({
				agent: step.agent || DEFAULT_AGENT,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: cwdResult.error,
			});
			break;
		}

		const result = await executeSingle(
			agents,
			step.agent,
			task,
			cwdResult.cwd,
			signal,
			onProgress,
			step.model,
			parentProvider,
			registry,
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

// ---------------------------------------------------------------------------
// Background agent registry — queryable by TUI / Telegram frontends
// ---------------------------------------------------------------------------

export interface BackgroundAgentInfo {
	agentId: string;
	agentType: string;
	taskSummary: string;
	startedAt: number;
	status: "running" | "completed" | "failed";
}

const backgroundAgentRegistry = new Map<string, BackgroundAgentInfo>();
const backgroundAbortControllers = new Map<string, AbortController>();

/** Get a snapshot of all tracked background agents (running and recently completed). Returns readonly clones. */
export function getBackgroundAgents(): readonly Readonly<BackgroundAgentInfo>[] {
	return [...backgroundAgentRegistry.values()].map((a) => ({ ...a }));
}

/** Get only currently running background agents. Returns readonly clones. */
export function getRunningBackgroundAgents(): readonly Readonly<BackgroundAgentInfo>[] {
	return [...backgroundAgentRegistry.values()].filter((a) => a.status === "running").map((a) => ({ ...a }));
}

/** Abort all running background agents. */
export function abortBackgroundAgents(): void {
	for (const [id, controller] of backgroundAbortControllers) {
		controller.abort();
		const entry = backgroundAgentRegistry.get(id);
		if (entry && entry.status === "running") {
			entry.status = "failed";
		}
	}
	backgroundAbortControllers.clear();
}

/** Remove completed/failed entries older than the given age (ms). Default: 5 minutes. */
export function pruneBackgroundAgents(maxAgeMs = 5 * 60 * 1000): void {
	const now = Date.now();
	for (const [id, info] of backgroundAgentRegistry) {
		if (info.status !== "running" && now - info.startedAt > maxAgeMs) {
			backgroundAgentRegistry.delete(id);
			backgroundAbortControllers.delete(id);
		}
	}
}

export interface SubagentToolOptions {
	/** Called when a background subagent starts. Used by TUI to show status indicators. */
	onBackgroundStart?: (agentId: string, agentType: string, taskSummary: string) => void;
	/** Called when a background subagent completes with its result. `cancelled` is true if the user aborted it. */
	onBackgroundComplete?: (agentId: string, result: SubagentResult, cancelled: boolean) => void;
	/** Parent session's provider (e.g. "anthropic"). Passed as --provider to child processes to constrain model resolution. */
	parentProvider?: string;
	/** Model registry for validating model names before spawning child processes. */
	modelRegistry?: ModelRegistry;
}

// ---------------------------------------------------------------------------
// Tool schema and definition
// ---------------------------------------------------------------------------

const taskItemSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (default: 'Explore')" })),
	task: Type.String({ description: "The task prompt for this subagent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory (defaults to parent's cwd)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this task (e.g. 'haiku', 'sonnet'). Takes precedence over agent definition model.",
		}),
	),
});

const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (default: 'Explore')" })),
	task: Type.Optional(Type.String({ description: "Task prompt (single mode)", minLength: 1 })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override (e.g. 'haiku', 'sonnet'). Takes precedence over agent definition model. For parallel/chain, set per-task instead.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(taskItemSchema, {
			description: "Array of tasks to run in parallel (max 8)",
			minItems: 1,
			maxItems: MAX_PARALLEL_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(taskItemSchema, {
			description: "Sequential pipeline — each step can use {previous} for prior output",
			minItems: 1,
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
		return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `chain (${args.chain.length} steps)`)}`;
	}

	const agent = str(args?.agent) || DEFAULT_AGENT;
	const model = str(args?.model);
	const task = str(args?.task);
	const taskPreview = task ? (task.length > 60 ? `${task.slice(0, 57)}...` : task) : null;
	const modelSuffix = model ? ` ${theme.fg("muted", `(${model})`)}` : "";
	return (
		theme.fg("toolTitle", theme.bold("subagent")) +
		" " +
		theme.fg("accent", agent) +
		modelSuffix +
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
	let text = `## Agent: ${result.agent}${result.model ? ` (model: ${result.model})` : ""}\n`;
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
	const onBackgroundStart = options?.onBackgroundStart;
	const onBackgroundComplete = options?.onBackgroundComplete;
	const parentProvider = options?.parentProvider;
	const modelRegistry = options?.modelRegistry;

	return {
		name: "subagent",
		label: "subagent",
		description:
			"Delegate tasks to independent subagents (Explore for codebase research, Sandbox for isolated /tmp-only analysis). " +
			"Supports single task, parallel (up to 8, max 4 concurrent), " +
			"and chain (sequential pipeline with {previous} substitution) modes. " +
			"Set background=true to return immediately and get notified on completion.",
		promptSnippet: "Delegate tasks to independent subagents (prefer background=true)",
		promptGuidelines: [
			"Use `subagent` to delegate focused, independent tasks to child agents",
			"Available agent types can be discovered from ~/.dreb/agents/ and .dreb/agents/ markdown files",
			"Built-in agents: 'Explore' (default) — read-only codebase exploration; 'Sandbox' — isolated analysis agent restricted to /tmp files only (no codebase access)",
			"Use parallel mode for independent tasks that can run concurrently",
			"Use chain mode when each step depends on the previous step's output (reference with {previous})",
			"ALWAYS use background=true when launching 2 or more subagents, or when the task is complex enough that you can do useful work while waiting. Foreground (blocking) mode should only be used for single subagents whose result you need immediately before deciding what to do next.",
			"Subagents have their own context window — provide enough context in the task prompt",
			"Each background agent notifies independently when done — completion messages include a list of any still-running agents",
			"Agent definitions may specify a `model` field using Anthropic-family names as strength-tier hints: 'opus' = strongest, 'sonnet' = mid-tier, 'haiku' = fast/cheap. These resolve via substring matching against the current provider's model list. If your provider doesn't carry matching models (e.g., on z.ai, OpenAI, etc.), you MUST pass a `model` override with your provider's equivalent: strongest tier (e.g., glm-5-1), mid tier (e.g., glm-5-turbo), or fast tier. Per-invocation `model` overrides always take precedence over agent definition models. For parallel/chain, set per-task.",
		],
		parameters: subagentSchema,

		async execute(_toolCallId, params: SubagentToolInput, signal, onUpdate) {
			const agents = discoverAgentTypes(cwd);

			// Determine mode
			const modeCount = (params.task ? 1 : 0) + (params.tasks ? 1 : 0) + (params.chain ? 1 : 0);
			if (modeCount === 0) {
				return {
					content: [
						{ type: "text", text: "Error: provide one of `task` (single), `tasks` (parallel), or `chain`." },
					],
					details: undefined,
				};
			}
			if (modeCount > 1) {
				return {
					content: [
						{
							type: "text",
							text: "Error: modes are mutually exclusive — provide only one of `task`, `tasks`, or `chain`.",
						},
					],
					details: undefined,
				};
			}

			// Background mode: spawn and return immediately
			if (params.background) {
				if (!onBackgroundComplete) {
					return {
						content: [
							{
								type: "text",
								text: "Background execution is not available in this session. Run without `background: true` instead.",
							},
						],
						details: undefined,
					};
				}

				// Helper to launch a single background task with its own agent ID and lifecycle
				const launchBackgroundTask = (
					agentName: string,
					task: string,
					taskLabel: string,
					taskCwd?: string,
					modelOverride?: string,
				) => {
					const resolvedCwd = taskCwd ?? cwd;
					const agentId = generateAgentId();
					const bgAbort = new AbortController();
					backgroundAgentRegistry.set(agentId, {
						agentId,
						agentType: agentName,
						taskSummary: taskLabel,
						startedAt: Date.now(),
						status: "running",
					});
					backgroundAbortControllers.set(agentId, bgAbort);
					onBackgroundStart?.(agentId, agentName, taskLabel);

					const bgSignal = bgAbort.signal;

					// Safe wrapper — prevents onBackgroundComplete errors from propagating
					const safeNotify = (result: SubagentResult) => {
						try {
							onBackgroundComplete(agentId, result, bgSignal.aborted);
						} catch (err) {
							console.error(
								`[subagent] onBackgroundComplete threw for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}. Background result lost.`,
							);
						}
					};

					const run = async () => {
						await bgAcquire();
						try {
							const result = await executeSingle(
								agents,
								agentName === DEFAULT_AGENT ? undefined : agentName,
								task,
								resolvedCwd,
								bgSignal,
								undefined,
								modelOverride,
								parentProvider,
								modelRegistry,
							);
							const entry = backgroundAgentRegistry.get(agentId);
							// Don't overwrite status if abort already set it to "failed"
							if (entry && !bgSignal.aborted) entry.status = result.exitCode === 0 ? "completed" : "failed";
							backgroundAbortControllers.delete(agentId);
							safeNotify(result);
						} catch (err) {
							const entry = backgroundAgentRegistry.get(agentId);
							if (entry && !bgSignal.aborted) entry.status = "failed";
							backgroundAbortControllers.delete(agentId);
							safeNotify({
								agent: agentName,
								task,
								exitCode: 1,
								output: "",
								stderr: "",
								errorMessage: err instanceof Error ? err.message : String(err),
							});
						} finally {
							bgRelease();
						}
					};
					run().catch((err) => {
						console.error(
							`[subagent] Unhandled background agent error (${agentId}): ${err instanceof Error ? err.message : String(err)}`,
						);
						const entry = backgroundAgentRegistry.get(agentId);
						if (entry && entry.status === "running") entry.status = "failed";
						backgroundAbortControllers.delete(agentId);
						try {
							onBackgroundComplete(
								agentId,
								{
									agent: agentName,
									task,
									exitCode: 1,
									output: "",
									stderr: "",
									errorMessage: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
								},
								bgSignal.aborted,
							);
						} catch (notifyErr) {
							console.error(
								`[subagent] CRITICAL: Last-resort notification failed for background agent ${agentId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
							);
						}
					});

					return agentId;
				};

				if (params.task) {
					// Single background task
					const agentName = params.agent || DEFAULT_AGENT;
					const agentId = launchBackgroundTask(
						agentName,
						params.task,
						`${agentName} task`,
						undefined,
						params.model,
					);
					return {
						content: [
							{
								type: "text",
								text: `Background agent ${agentId} started (${agentName}). You will be notified when it completes.`,
							},
						],
						details: { mode: "single", agentCount: 1 } as SubagentToolDetails,
					};
				} else if (params.tasks) {
					// Parallel background tasks — each gets its own agent ID and notifies independently
					const launched: Array<{ id: string; taskText: string }> = [];
					const skipped: Array<{ taskText: string; error: string }> = [];
					for (let i = 0; i < params.tasks.length; i++) {
						const item = params.tasks[i];
						const agentName = item.agent || DEFAULT_AGENT;
						const cwdResult = clampCwd(cwd, item.cwd);
						if (!cwdResult.ok) {
							skipped.push({ taskText: item.task, error: cwdResult.error });
							continue;
						}
						const agentId = launchBackgroundTask(
							agentName,
							item.task,
							`${agentName} task ${i + 1}/${params.tasks.length}`,
							cwdResult.cwd,
							item.model,
						);
						launched.push({ id: agentId, taskText: item.task });
					}
					const listing = launched.map(({ id, taskText }) => `  ${id}: ${taskText.slice(0, 80)}`).join("\n");
					const skippedListing = skipped
						.map(({ taskText, error }) => `  SKIPPED: ${taskText.slice(0, 60)} — ${error}`)
						.join("\n");
					const parts = [`${launched.length} background agents started:\n${listing}`];
					if (skipped.length > 0) {
						parts.push(`\n${skipped.length} task(s) failed to launch:\n${skippedListing}`);
					}
					if (launched.length > 0) {
						parts.push("\nEach will notify independently when complete.");
					} else {
						parts.push("\nNo agents were launched.");
					}
					return {
						content: [
							{
								type: "text",
								text: parts.join("\n"),
							},
						],
						details: { mode: "parallel", agentCount: launched.length } as SubagentToolDetails,
					};
				} else {
					// Chain mode — sequential, stays as one agent since steps depend on each other
					const agentId = generateAgentId();
					const agentName = params.chain![0].agent || DEFAULT_AGENT;
					const taskSummary = `${params.chain!.length}-step chain`;
					const bgAbort = new AbortController();
					backgroundAgentRegistry.set(agentId, {
						agentId,
						agentType: agentName,
						taskSummary,
						startedAt: Date.now(),
						status: "running",
					});
					backgroundAbortControllers.set(agentId, bgAbort);
					onBackgroundStart?.(agentId, agentName, taskSummary);

					const bgSignal = bgAbort.signal;
					const safeNotify = (result: SubagentResult) => {
						try {
							onBackgroundComplete(agentId, result, bgSignal.aborted);
						} catch (err) {
							console.error(
								`[subagent] onBackgroundComplete threw for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					};
					const runChain = async () => {
						try {
							const results = await executeChain(
								agents,
								params.chain!,
								cwd,
								bgSignal,
								undefined,
								parentProvider,
								modelRegistry,
							);
							const resultText = results
								.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`)
								.join("\n\n---\n\n");
							const failed = results.filter((r) => r.exitCode !== 0);
							const result: SubagentResult = {
								agent: "chain",
								task: taskSummary,
								exitCode: failed.length > 0 ? 1 : 0,
								output: resultText,
								stderr: "",
								errorMessage:
									failed.length > 0
										? `Chain stopped at step ${results.length} of ${params.chain!.length}: ${results[results.length - 1]?.errorMessage}`
										: null,
							};
							const entry = backgroundAgentRegistry.get(agentId);
							if (entry && !bgSignal.aborted) entry.status = result.exitCode === 0 ? "completed" : "failed";
							backgroundAbortControllers.delete(agentId);
							safeNotify(result);
						} catch (err) {
							const entry = backgroundAgentRegistry.get(agentId);
							if (entry && !bgSignal.aborted) entry.status = "failed";
							backgroundAbortControllers.delete(agentId);
							safeNotify({
								agent: agentName,
								task: taskSummary,
								exitCode: 1,
								output: "",
								stderr: "",
								errorMessage: err instanceof Error ? err.message : String(err),
							});
						}
					};
					runChain().catch((err) => {
						console.error(
							`[subagent] Unhandled background chain error (${agentId}): ${err instanceof Error ? err.message : String(err)}`,
						);
						const entry = backgroundAgentRegistry.get(agentId);
						if (entry && entry.status === "running") entry.status = "failed";
						backgroundAbortControllers.delete(agentId);
						try {
							onBackgroundComplete(
								agentId,
								{
									agent: agentName,
									task: taskSummary,
									exitCode: 1,
									output: "",
									stderr: "",
									errorMessage: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
								},
								bgSignal.aborted,
							);
						} catch (notifyErr) {
							console.error(
								`[subagent] CRITICAL: Last-resort notification failed for background chain ${agentId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
							);
						}
					});

					return {
						content: [
							{
								type: "text",
								text: `Background chain ${agentId} started (${taskSummary}). You will be notified when it completes.`,
							},
						],
						details: { mode: "chain", agentCount: params.chain!.length } as SubagentToolDetails,
					};
				}
			}

			// Foreground mode: run and wait for results
			const progressCallback = onUpdate
				? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }] } as any)
				: undefined;

			let resultText: string;
			let details: SubagentToolDetails;

			if (params.task) {
				const result = await executeSingle(
					agents,
					params.agent,
					params.task,
					cwd,
					signal ?? undefined,
					progressCallback,
					params.model,
					parentProvider,
					modelRegistry,
				);
				resultText = formatSingleResult(result);
				details = { mode: "single", agentCount: 1 };
			} else if (params.tasks) {
				const results = await executeParallel(
					agents,
					params.tasks,
					cwd,
					signal ?? undefined,
					progressCallback,
					parentProvider,
					modelRegistry,
				);
				resultText = results.map((r, i) => `### Task ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
				details = { mode: "parallel", agentCount: params.tasks.length };
			} else {
				const results = await executeChain(
					agents,
					params.chain!,
					cwd,
					signal ?? undefined,
					progressCallback,
					parentProvider,
					modelRegistry,
				);
				resultText = results.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`).join("\n\n---\n\n");
				details = { mode: "chain", agentCount: params.chain!.length };
			}

			const truncation = truncateHead(resultText, { maxLines: Number.MAX_SAFE_INTEGER });
			if (truncation.truncated) {
				details.truncation = truncation;
			}

			return {
				content: [{ type: "text", text: truncation.content }],
				details,
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
