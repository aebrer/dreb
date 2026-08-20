import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, type Dirent, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentTool, ThinkingLevel } from "@dreb/agent-core";
import { type Api, type AssistantMessage, type Context, completeSimple, type Model } from "@dreb/ai";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME, getPackageDir, getSubagentSessionsDir } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.js";
import type { RpcClient } from "../../modes/rpc/rpc-client.js";
import type { RpcPendingMessages } from "../../modes/rpc/rpc-types.js";
import type {
	DispatchAgentSummary,
	DispatchArbitrationRecord,
	DispatchArbitrationRequest,
	DispatchArbitrationResult,
	DispatchRoute,
} from "../dispatch-arbiter.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { log } from "../logger.js";
import type { ModelRegistry } from "../model-registry.js";
import { resolveCliModel } from "../model-resolver.js";
import { DEFAULT_MAX_CONCURRENT_SUBAGENTS } from "../settings-manager.js";
import { resolveEffectiveThinkingLevel, thinkingLevelToReasoning, validateThinkingLevelForModel } from "../thinking.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.js";

// ---------------------------------------------------------------------------
// Agent type system
// ---------------------------------------------------------------------------

export interface AgentTypeConfig {
	name: string;
	description: string;
	tools?: string;
	/** Single model ID or ordered fallback list. First resolvable model wins. */
	model?: string | string[];
	systemPrompt: string;
}

const DEFAULT_AGENT = "Explore";
const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_MODEL_AVAILABILITY_PROBE_TIMEOUT_MS = 120_000;

export function parseAgentFrontmatter(
	content: string,
): { ok: true; config: AgentTypeConfig } | { ok: false; error: string } {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return { ok: false, error: "missing --- frontmatter delimiters" };

	const frontmatter = fmMatch[1];
	const body = fmMatch[2].trim();

	const get = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match?.[1].trim();
	};

	/** Parse `model` field — supports single string, comma-separated, or YAML list syntax. */
	const getModel = (): string | string[] | undefined => {
		// First check for YAML list syntax (indented lines starting with "- ")
		const listMatch = frontmatter.match(/^model:\s*\n((?:\s+-\s+.+\n?)+)/m);
		if (listMatch) {
			const items = listMatch[1]
				.split("\n")
				.map((line) => line.replace(/^\s+-\s+/, "").trim())
				.filter(Boolean);
			return items.length > 1 ? items : items[0];
		}
		// Inline value — check for comma-separated list
		const value = get("model");
		if (!value) return undefined;
		if (value.includes(",")) {
			const items = value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			return items.length > 1 ? items : items[0];
		}
		return value;
	};

	const name = get("name");
	if (!name) return { ok: false, error: "missing required 'name' field in frontmatter" };

	return {
		ok: true,
		config: {
			name,
			description: get("description") || "",
			tools: get("tools"),
			model: getModel(),
			systemPrompt: body,
		},
	};
}

export function discoverAgentTypes(cwd: string): Map<string, AgentTypeConfig> {
	const agents = new Map<string, AgentTypeConfig>();

	// Package-bundled agents (shipped with dreb — the canonical source of truth for built-in agents)
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
					log.warn(`[subagent] Skipping agent file ${join(dir, file)}: ${parsed.error}`);
				} else {
					agents.set(parsed.config.name, parsed.config);
				}
			} catch (err) {
				log.warn(
					`[subagent] Could not read agent file ${join(dir, file)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn(
				`[subagent] Could not read agents directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Subagent process spawning
// ---------------------------------------------------------------------------

export interface SubagentStepMetadata {
	step: number;
	agent: string;
	success: boolean;
	/** Canonical provider/model identity reported by the child process. */
	model?: string;
	/** Effective thinking level reported by the child process. */
	thinking?: ThinkingLevel;
}

export interface SubagentArbitrationEvent extends DispatchArbitrationRecord {
	type: "subagent_arbitration";
	agentId: string;
}

export interface SubagentResult {
	agent: string;
	task: string;
	/** Canonical provider/model identity reported by the child process. */
	model?: string;
	/** Effective thinking level reported by the child process. */
	thinking?: ThinkingLevel;
	/** Ordered effective metadata for chain steps. */
	steps?: SubagentStepMetadata[];
	exitCode: number;
	output: string;
	stderr: string;
	errorMessage: string | null;
	/** Path to the persisted session JSONL file, if available */
	sessionFile?: string;
}

// Capture at module load before process.title overwrites argv memory on Linux.
// After process.title = "dreb" (in cli.ts), the original argv area is overwritten
// and process.argv[1] may return corrupted or truncated data.
const DREB_SCRIPT = process.argv[1] || "dreb";
const NODE_EXEC = process.execPath;

// Tools that must never be available to subagents — wait (subagents should
// never no-op; they have a task to complete), watch_github_ci (parent workflow
// orchestration), subagent (no recursive spawning), and suggest_next (would end
// the subagent's turn mid-work).
const SUBAGENT_EXCLUDED_TOOLS = ["wait", "watch_github_ci", "subagent", "suggest_next"] as const;

// Default standard tools for subagents when no tools are specified in the agent
// definition. This is the set passed via --tools to the child process.
//
// NOTE: Always-active tools (search, skill, tasks_update) are NOT listed here —
// the child process adds them unconditionally regardless of --tools.
// Internal tools (tmp_read) are also excluded.
const SUBAGENT_DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"];
const SUBAGENT_ALWAYS_ACTIVE_TOOLS = ["search", "skill", "tasks_update"];

/**
 * Filter a comma-separated tools string, removing any tools in SUBAGENT_EXCLUDED_TOOLS.
 * Returns the filtered tools as a comma-separated string (always non-empty — falls
 * back to SUBAGENT_DEFAULT_TOOLS if all specified tools were excluded).
 */
export function filterSubagentTools(tools: string | undefined): string {
	if (!tools) return SUBAGENT_DEFAULT_TOOLS.join(",");
	const filtered = tools
		.split(",")
		.map((t) => t.trim())
		.filter((t) => !(SUBAGENT_EXCLUDED_TOOLS as readonly string[]).includes(t))
		.join(",");
	return filtered || SUBAGENT_DEFAULT_TOOLS.join(",");
}

function summarizeAgentsForArbitration(
	agents: Map<string, AgentTypeConfig>,
	getAgentModelsForAgent?: (name: string) => string[] | undefined,
): DispatchAgentSummary[] {
	return [...agents.values()].map((agent) => {
		const settingsModels = getAgentModelsForAgent?.(agent.name);
		return {
			name: agent.name,
			description: agent.description,
			tools: [
				...new Set([
					...filterSubagentTools(agent.tools).split(",").filter(Boolean),
					...SUBAGENT_ALWAYS_ACTIVE_TOOLS,
				]),
			],
			modelDefaults:
				settingsModels && settingsModels.length > 0
					? [...settingsModels]
					: agent.model
						? Array.isArray(agent.model)
							? [...agent.model]
							: [agent.model]
						: [],
		};
	});
}

// TODO: Support PATH-based binary discovery.
// Currently returns the captured argv[1].
function findDrebBinary(): string {
	return DREB_SCRIPT;
}

/**
 * Sinks for the child process's JSONL stdout stream. Extracted so the line
 * handling is unit-testable without spawning a real child process.
 */
export interface ChildLineSinks {
	/** Called with every successfully parsed JSONL event (including the session header). */
	onEvent?: (event: Record<string, unknown>) => void;
	/** Called with each complete assistant message (`message_end`). */
	onAssistantMessage: (message: { role: string; content: any[] }) => void;
	/** Called with human-readable progress lines (tool start/end). */
	onProgress?: (text: string) => void;
	/** Called when the child reports its canonical resolved model (`agent_start`). */
	onModel: (modelRef: string) => void;
	/** Called when the child reports its effective thinking level (`agent_start`). */
	onThinking?: (thinkingLevel: ThinkingLevel) => void;
	/** Called with lines that failed to parse as JSON (often real startup errors). */
	onPlainLine: (line: string) => void;
	/** Mutable holder for the last tool name, shared across lines for progress text. */
	toolNameRef: { current: string };
}

function canonicalModelRef(provider: string | undefined, modelId: string): string {
	if (!provider || modelId.startsWith(`${provider}/`)) return modelId;
	return `${provider}/${modelId}`;
}

/**
 * Handle one line of a subagent child's JSONL stdout. Parses the line and
 * dispatches to the sinks: full-event relay, assistant-message collection,
 * tool progress, resolved model, and non-JSON passthrough.
 */
export function handleChildJsonlLine(line: string, sinks: ChildLineSinks): void {
	if (!line.trim()) return;
	// Separate JSON.parse from event handling so only parse failures
	// are caught as non-JSON lines — errors in handling propagate normally
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		// Capture non-JSON lines — on failure these often contain the real error
		// (e.g. startup errors printed before JSONL mode begins)
		sinks.onPlainLine(line.trim());
		if (line.trim().startsWith("{")) {
			log.warn(`[subagent] Failed to parse JSONL event: ${line.slice(0, 200)}`);
		}
		return;
	}
	if (event === null || typeof event !== "object") {
		// Valid JSON but not an event object (e.g. a bare string or number) — treat
		// like a plain line so diagnostic content is preserved.
		sinks.onPlainLine(line.trim());
		return;
	}
	if (typeof event.type === "string") {
		sinks.onEvent?.(event);
	}
	if (event.type === "agent_start") {
		if (typeof event.model?.id === "string") {
			const provider = typeof event.model.provider === "string" ? event.model.provider : undefined;
			sinks.onModel(canonicalModelRef(provider, event.model.id));
		}
		if (
			typeof event.thinkingLevel === "string" &&
			(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(event.thinkingLevel)
		) {
			sinks.onThinking?.(event.thinkingLevel as ThinkingLevel);
		}
	}
	if (event.type === "message_end" && event.message?.role === "assistant") {
		sinks.onAssistantMessage(event.message);
	}
	if (event.type === "tool_execution_start" && sinks.onProgress) {
		sinks.toolNameRef.current = event.toolName || "";
		sinks.onProgress(`Using ${sinks.toolNameRef.current}...`);
	}
	if (event.type === "tool_execution_end" && sinks.onProgress) {
		sinks.onProgress(`${sinks.toolNameRef.current} done`);
	}
}

async function spawnSubagent(
	agentConfig: AgentTypeConfig,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
	sessionDir?: string,
	parentSessionFile?: string,
	onChildEvent?: (event: Record<string, unknown>) => void,
	thinkingOverride?: ThinkingLevel,
	onControlAvailable?: (client: RpcClient | undefined) => void,
): Promise<SubagentResult> {
	const drebBin = findDrebBinary();
	log.debug(`[subagent] spawn: agent=${agentConfig.name} cwd=${cwd}`);

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

	const args: string[] = ["--mode", "json", "--ui", "agent"];
	if (sessionDir) {
		args.push("--session-dir", sessionDir);
	} else {
		args.push("--no-session");
	}
	// By spawn time, model should be a resolved single string (fallback resolution
	// happens in executeSingle). Handle string[] defensively by taking the first entry.
	const modelStr = Array.isArray(agentConfig.model) ? agentConfig.model[0] : agentConfig.model;
	if (modelStr) {
		args.push("--model", modelStr);
		// executeSingle resolves the model and provider independently. Always pass
		// that exact provider because raw model IDs may themselves contain slashes
		// (for example, OpenRouter IDs such as "openai/gpt-oss-120b").
		if (parentProvider) {
			args.push("--provider", parentProvider);
		}
	}
	if (thinkingOverride) {
		args.push("--thinking", thinkingOverride);
	}
	// Always pass --tools to ensure wait/subagent/suggest_next are excluded from child processes.
	// filterSubagentTools always returns a non-empty string.
	args.push("--tools", filterSubagentTools(agentConfig.tools));
	if (agentConfig.systemPrompt) {
		args.push("--append-system-prompt", agentConfig.systemPrompt);
	}
	// Pass agent type metadata so the child session can record it in its JSONL header
	args.push("--agent-type", agentConfig.name);
	// Pass parent session file path so the child session can record it in its JSONL header
	if (parentSessionFile) {
		args.push("--parent-session", parentSessionFile);
	}
	args.push("-p", task);
	if (onControlAvailable) {
		const rpcModeIndex = args.indexOf("json");
		if (rpcModeIndex !== -1) args[rpcModeIndex] = "rpc";
		args.splice(args.length - 2, 2);
	}

	// Early abort check — if the signal is already aborted (e.g. queued task whose
	// AbortController was aborted while waiting on bgAcquire), bail out before
	// spawning a child process that can never be killed. addEventListener("abort")
	// on an already-aborted signal does NOT fire the callback in Node.js.
	if (signal?.aborted) {
		return {
			agent: agentConfig.name,
			task,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: "Aborted before spawn",
		};
	}

	return new Promise<SubagentResult>((resolvePromise, rejectPromise) => {
		let proc: ChildProcess;
		try {
			proc = spawn(NODE_EXEC, [drebBin, ...args], {
				cwd,
				stdio: [onControlAvailable ? "pipe" : "ignore", "pipe", "pipe"],
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
		const toolNameRef = { current: "" };
		let resolvedModel: string | undefined;
		let resolvedThinking: ThinkingLevel | undefined;
		let rpcRequestId = 0;
		let rpcCompleted = false;
		let controlError: Error | undefined;
		const pendingRpc = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		const sendRpc = <T>(command: Record<string, unknown>): Promise<T> => {
			if (!proc.stdin?.writable) return Promise.reject(new Error("Subagent control channel is unavailable."));
			const id = `subagent-${++rpcRequestId}`;
			proc.stdin.write(serializeJsonLine({ ...command, id }));
			return new Promise<T>((resolve, reject) => pendingRpc.set(id, { resolve, reject }));
		};
		const controlClient = onControlAvailable
			? ({
					steer: async (message: string) => {
						await sendRpc({ type: "steer", message });
					},
					getPendingMessages: async () => sendRpc<RpcPendingMessages>({ type: "get_pending_messages" }),
					getState: async () => sendRpc<{ steeringMode: "all" | "one-at-a-time" }>({ type: "get_state" }),
				} as RpcClient)
			: undefined;

		// Terminally fail a controlled child: remember the first failure, reject all
		// in-flight control requests, and stop the process (with the same SIGKILL
		// backstop as the abort path) so the close handler settles instead of the
		// child idling in RPC mode forever.
		const failControlledChild = (err: Error) => {
			if (!controlError) controlError = err;
			for (const request of pendingRpc.values()) request.reject(err);
			pendingRpc.clear();
			try {
				proc.kill("SIGTERM");
			} catch {
				/* process already exited */
			}
			killTimer ??= setTimeout(() => {
				try {
					if (!proc.killed) proc.kill("SIGKILL");
				} catch {
					/* process already exited */
				}
			}, 5000);
		};

		proc.stdin?.on("error", (err) => {
			log.warn(`[subagent] stdin stream error (agent=${agentConfig.name}): ${err.message}`);
			failControlledChild(err);
		});

		// Drain stderr concurrently to avoid pipe deadlock (capped to prevent OOM from verbose subagents)
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrSize < MAX_STDERR_BYTES) {
				const str = chunk.toString();
				stderrChunks.push(str);
				stderrSize += str.length;
			}
		});
		proc.stderr?.on("error", (err) => {
			log.warn(`[subagent] stderr stream error (agent=${agentConfig.name}): ${err.message}`);
		});

		// Parse JSONL events from stdout
		if (proc.stdout) {
			proc.stdout.on("error", (err) => {
				log.warn(`[subagent] stdout stream error (agent=${agentConfig.name}): ${err.message}`);
			});
			attachJsonlLineReader(proc.stdout, (line) => {
				if (onControlAvailable) {
					try {
						const message = JSON.parse(line);
						if (message?.type === "agent_end" && !rpcCompleted) {
							rpcCompleted = true;
							setImmediate(() => proc.kill("SIGTERM"));
						}
						if (message?.type === "response" && typeof message.id === "string") {
							const pending = pendingRpc.get(message.id);
							if (pending) {
								pendingRpc.delete(message.id);
								if (message.success) pending.resolve(message.data);
								else pending.reject(new Error(message.error ?? "Subagent RPC command failed."));
							} else if (message.command === "prompt" && message.success === false && !rpcCompleted) {
								// Late failure of the initial prompt: the child acknowledged the
								// command synchronously, then failed before the agent loop started
								// (e.g. model/API-key validation, or the task was consumed without
								// starting the loop), so no agent_end will ever settle this process.
								failControlledChild(
									new Error(typeof message.error === "string" ? message.error : "Subagent prompt failed."),
								);
							}
							return;
						}
					} catch {
						// The normal line handler preserves non-JSON diagnostics.
					}
				}
				handleChildJsonlLine(line, {
					onEvent: onChildEvent,
					onAssistantMessage: (message) => collectedMessages.push(message),
					onProgress,
					onModel: (modelRef) => {
						resolvedModel = modelRef;
					},
					onThinking: (thinkingLevel) => {
						resolvedThinking = thinkingLevel;
					},
					onPlainLine: (plain) => plainStdoutLines.push(plain),
					toolNameRef,
				});
			});
		}

		if (onControlAvailable && controlClient) {
			onControlAvailable(controlClient);
			void sendRpc({ type: "prompt", message: task }).catch((err) => {
				const error = err instanceof Error ? err : new Error(String(err));
				log.warn(`[subagent] initial RPC prompt failed (agent=${agentConfig.name}): ${error.message}`);
				// A rejected initial prompt means the agent loop never starts and the
				// child would idle in RPC mode forever — terminate it and fail loudly.
				failControlledChild(error);
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
			onControlAvailable?.(undefined);
			for (const request of pendingRpc.values()) request.reject(err);
			pendingRpc.clear();
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(new Error(`Subagent process error: ${err.message}`));
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			onControlAvailable?.(undefined);
			for (const request of pendingRpc.values()) request.reject(new Error("Subagent process exited."));
			pendingRpc.clear();
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			const exitCode = rpcCompleted ? 0 : (code ?? 1);
			const stderr = stderrChunks.join("");
			log.debug(
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

			// Inspect the final assistant message's stopReason to detect truncation
			// ("length") or a loud truncation failure ("error") from the core agent loop.
			// stopReason is present at runtime even though collectedMessages is loosely typed.
			const lastMsg = collectedMessages.length > 0 ? collectedMessages[collectedMessages.length - 1] : undefined;
			const lastStopReason = lastMsg ? (lastMsg as any).stopReason : undefined;
			const lastErrorMessage = lastMsg ? (lastMsg as any).errorMessage : undefined;

			// Build error message from best available source: stderr, plain stdout lines, or generic
			let errorMessage: string | null = null;
			if (exitCode !== 0) {
				const stderrTrimmed = stderr.trim();
				const plainOutput = plainStdoutLines.join("\n").trim();
				errorMessage =
					controlError?.message.slice(0, 500) ||
					stderrTrimmed.slice(0, 500) ||
					plainOutput.slice(0, 500) ||
					`Subagent exited with code ${exitCode}`;
			} else if (output.trim() === "") {
				// Clean exit but no output — surface why instead of returning a silent empty result.
				if (lastStopReason === "length") {
					errorMessage = "Subagent response was truncated at the model's token limit before producing any output.";
				} else if (lastStopReason === "error" && lastErrorMessage) {
					errorMessage = String(lastErrorMessage).slice(0, 500);
				} else {
					errorMessage = "Subagent completed with no output.";
				}
			} else if (lastStopReason === "length") {
				// Clean exit with partial output — keep the output but make the truncation loud.
				errorMessage = "Subagent response was truncated at the model's token limit; output may be incomplete.";
			} else if (lastStopReason === "error" && lastErrorMessage) {
				// Clean exit with partial output but a loud failure (e.g. length retries
				// exhausted → the core agent loop converts the truncation to stopReason
				// "error" while preserving the partial text). Surface the error instead of
				// letting the partial output masquerade as a clean success.
				errorMessage = String(lastErrorMessage).slice(0, 500);
			}

			// Discover the session file written by the child process
			const sessionFile = sessionDir ? discoverSessionFile(sessionDir, agentConfig.name) : undefined;
			const configuredModel = Array.isArray(agentConfig.model) ? agentConfig.model[0] : agentConfig.model;

			resolvePromise({
				agent: agentConfig.name,
				task,
				model:
					resolvedModel ??
					(exitCode === 0 && configuredModel ? canonicalModelRef(parentProvider, configuredModel) : undefined),
				thinking: resolvedThinking ?? (exitCode === 0 ? thinkingOverride : undefined),
				exitCode,
				output,
				stderr: stderr.slice(0, 2000), // cap stderr
				errorMessage,
				sessionFile,
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Session file discovery and cleanup
// ---------------------------------------------------------------------------

interface SessionFileCandidate {
	path: string;
	mtime: number;
}

const STEP_SESSION_DIR_RE = /^step-(\d+)$/;

function findNewestJsonlFileInDir(dir: string): SessionFileCandidate | undefined {
	let best: SessionFileCandidate | undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".jsonl")) continue;
		if (entry.isDirectory()) continue;
		const fullPath = join(dir, entry.name);
		try {
			const mtime = statSync(fullPath).mtime.getTime();
			if (!best || mtime > best.mtime) best = { path: fullPath, mtime };
		} catch (err) {
			if (isExpectedFilesystemError(err)) continue;
			throw err;
		}
	}
	return best;
}

function discoverStepSessionFileCandidates(sessionDir: string): SessionFileCandidate[] {
	const steps: Array<{ name: string; index: number }> = [];
	for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const match = STEP_SESSION_DIR_RE.exec(entry.name);
		if (!match) continue;
		steps.push({ name: entry.name, index: Number(match[1]) });
	}
	steps.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));

	const files: SessionFileCandidate[] = [];
	for (const step of steps) {
		try {
			const candidate = findNewestJsonlFileInDir(join(sessionDir, step.name));
			if (candidate) files.push(candidate);
		} catch (err) {
			if (isExpectedFilesystemError(err)) continue;
			throw err;
		}
	}
	return files;
}

/**
 * Find session JSONL files for a subagent session directory.
 *
 * Normal subagents write one .jsonl directly under sessionDir, so this returns
 * the most recently modified flat file. Chain-mode subagents register the chain
 * root as sessionDir but write each step under step-N/, so when no flat file is
 * present this recurses one level into step-* directories and returns one file
 * per step in numeric step order.
 */
export function discoverSessionFiles(sessionDir: string, agentName: string): string[] {
	try {
		if (!existsSync(sessionDir)) return [];
		const flatFile = findNewestJsonlFileInDir(sessionDir);
		if (flatFile) {
			log.debug(`[subagent] session file: ${flatFile.path} (agent=${agentName})`);
			return [flatFile.path];
		}

		const stepFiles = discoverStepSessionFileCandidates(sessionDir);
		if (stepFiles.length > 0) {
			log.debug(
				`[subagent] chain session files: ${stepFiles.map((file) => file.path).join(", ")} (agent=${agentName})`,
			);
			return stepFiles.map((file) => file.path);
		}
	} catch (err) {
		if (!isExpectedFilesystemError(err)) throw err;
		log.warn(
			`[subagent] failed to discover session file (agent=${agentName}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return [];
}

/**
 * Find the most recently modified .jsonl file in a session directory.
 * Returns the full path, or undefined if no session file was written
 * (e.g., subagent was killed before the first assistant message).
 */
export function discoverSessionFile(sessionDir: string, agentName: string): string | undefined {
	const files = discoverSessionFiles(sessionDir, agentName);
	if (files.length <= 1) return files[0];

	let best: SessionFileCandidate | undefined;
	for (const file of files) {
		try {
			const candidate = { path: file, mtime: statSync(file).mtime.getTime() };
			if (!best || candidate.mtime > best.mtime) best = candidate;
		} catch (err) {
			if (isExpectedFilesystemError(err)) continue;
			throw err;
		}
	}
	return best?.path;
}

// ---------------------------------------------------------------------------
// Execution modes
// ---------------------------------------------------------------------------

/**
 * Resolve a model fallback list against the registry. Tries each model in order,
 * returns the first one that resolves successfully. If all fail, returns the
 * last error. Single strings are treated as a one-element list.
 */
export function resolveModelWithFallbacks(
	models: string | string[],
	parentProvider: string | undefined,
	registry: ModelRegistry | undefined,
	parentModel?: string,
): { ok: true; modelId: string; provider?: string; warning?: string } | { ok: false; error: string } {
	const modelList = Array.isArray(models) ? models : [models];
	let lastError = "";
	for (const modelStr of modelList) {
		const result = resolveModelStringSingle(modelStr, parentProvider, registry);
		if (result.ok) return result;
		lastError = result.error;
	}
	// After all configured fallbacks are exhausted, try the parent model as a last resort
	if (parentModel) {
		const result = resolveModelStringSingle(parentModel, parentProvider, registry);
		if (result.ok) {
			return {
				...result,
				warning: `Agent preferred models were unavailable. Falling back to parent model "${result.modelId}".`,
			};
		}
		lastError = result.error;
	}
	if (modelList.length > 1 || parentModel) {
		return {
			ok: false,
			error: `None of the fallback models resolved: ${[...modelList, ...(parentModel ? [parentModel] : [])].join(", ")}. Last error: ${lastError}`,
		};
	}
	return { ok: false, error: lastError };
}

export function resolveModelStringSingle(
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

	// resolveCliModel creates a synthetic model for any unknown ID when a
	// provider is specified (designed for custom/self-hosted models like Ollama).
	// For subagents this causes silent failures — reject synthetic fallbacks
	// so the next model in the fallback list is tried instead.
	if (resolved.isSyntheticFallback) {
		return {
			ok: false,
			error: `Model "${modelStr}" not found for provider "${resolved.model.provider}". Use --list-models to see available models.`,
		};
	}

	// Verify the resolved provider has authentication configured.
	// resolveCliModel uses getAll() (all models, not just authenticated ones)
	// so a model can resolve successfully to a provider with no API key.
	// Reject early so the fallback list can continue to the next model.
	if (!registry.authStorage.hasAuth(resolved.model.provider)) {
		return {
			ok: false,
			error: `No authentication configured for provider "${resolved.model.provider}". Model "${modelStr}" cannot be used.`,
		};
	}

	return { ok: true, modelId: resolved.model.id, provider: resolved.model.provider };
}

export interface ProbeModelAvailabilityOptions {
	/** Parent/tool abort signal. A model availability probe timeout is layered on top. */
	signal?: AbortSignal;
	/** Model registry used to resolve provider API keys for the probe call. */
	registry?: ModelRegistry;
	/** Override the default model availability probe timeout; primarily useful for tests. */
	timeoutMs?: number;
}

export type ProbeModelAvailabilityResult = { ok: true } | { ok: false; reason: string; aborted?: boolean };

function compactErrorReason(reason: string): string {
	const singleLine = reason.replace(/\s+/g, " ").trim();
	return singleLine.length > 180 ? `${singleLine.slice(0, 177)}...` : singleLine || "unknown error";
}

function reasonFromRuntimeError(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	if (value && typeof value === "object") {
		const maybeMessage = value as Partial<AssistantMessage> & { message?: unknown };
		if (typeof maybeMessage.errorMessage === "string") return maybeMessage.errorMessage;
		if (typeof maybeMessage.message === "string") return maybeMessage.message;
	}
	return String(value);
}

export function isRuntimeUnavailableError(value: unknown): boolean {
	if (value instanceof Error || typeof value === "string") return true;
	if (value && typeof value === "object") {
		const maybeMessage = value as Partial<AssistantMessage>;
		return maybeMessage.stopReason === "error" || maybeMessage.stopReason === "aborted";
	}
	return false;
}

function makeProbeSignal(
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; timeoutPromise: Promise<never>; cleanup: () => void } {
	const controller = new AbortController();
	const timeoutError = new Error(`Model availability probe timed out after ${timeoutMs}ms`);
	let timeout: ReturnType<typeof setTimeout>;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			controller.abort(timeoutError);
			reject(timeoutError);
		}, timeoutMs);
	});
	const parentAbortHandler = () => controller.abort(parentSignal?.reason);
	parentSignal?.addEventListener("abort", parentAbortHandler, { once: true });
	if (parentSignal?.aborted) controller.abort(parentSignal.reason);

	return {
		signal: controller.signal,
		timeoutPromise,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", parentAbortHandler);
		},
	};
}

export async function probeModelAvailability(
	model: Model<Api>,
	options: ProbeModelAvailabilityOptions = {},
): Promise<ProbeModelAvailabilityResult> {
	const { signal, registry, timeoutMs = DEFAULT_MODEL_AVAILABILITY_PROBE_TIMEOUT_MS } = options;
	if (signal?.aborted) return { ok: false, reason: "Aborted before spawn", aborted: true };

	const probeSignal = makeProbeSignal(signal, timeoutMs);
	try {
		const context: Context = {
			systemPrompt: "Reply with the single word OK.",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};
		const apiKey = await Promise.race([
			registry ? registry.getApiKey(model) : Promise.resolve(undefined),
			probeSignal.timeoutPromise,
		]);
		if (signal?.aborted) return { ok: false, reason: "Aborted before spawn", aborted: true };
		const thinkingLevel = resolveEffectiveThinkingLevel(model, undefined);
		const reasoning = thinkingLevelToReasoning(thinkingLevel);
		// Use completeSimple — the same streamSimple path the agent loop uses.
		// No maxTokens override is passed by the probe; buildBaseOptions applies
		// normal model defaults. Reasoning is resolved through the shared normal
		// coding-agent thinking default/clamp path instead of provider-specific
		// probe logic, so reasoning models are probed with representative options.
		const result = await Promise.race([
			completeSimple(model, context, {
				apiKey,
				maxRetryDelayMs: 0,
				reasoning,
				signal: probeSignal.signal,
			}),
			probeSignal.timeoutPromise,
		]);
		if (signal?.aborted) return { ok: false, reason: "Aborted before spawn", aborted: true };
		if (isRuntimeUnavailableError(result)) {
			return { ok: false, reason: compactErrorReason(reasonFromRuntimeError(result)) };
		}
		return { ok: true };
	} catch (err) {
		if (signal?.aborted) return { ok: false, reason: "Aborted before spawn", aborted: true };
		return { ok: false, reason: compactErrorReason(reasonFromRuntimeError(err)) };
	} finally {
		probeSignal.cleanup();
	}
}

export interface SkippedFallbackModel {
	model: string;
	reason: string;
}

export type SubagentModelResolution =
	| {
			ok: true;
			modelId: string;
			provider?: string;
			warning?: string;
			skippedModels: SkippedFallbackModel[];
	  }
	| { ok: false; error: string; skippedModels: SkippedFallbackModel[] };

export async function resolveModelForSubagentSpawn(
	models: string | string[],
	parentProvider: string | undefined,
	registry: ModelRegistry | undefined,
	parentModel?: string,
	signal?: AbortSignal,
	/** Optional log prefix for warning messages (defaults to "[subagent]") */
	logPrefix = "[subagent]",
): Promise<SubagentModelResolution> {
	if (signal?.aborted) return { ok: false, error: "Aborted before spawn", skippedModels: [] };

	// Runtime probing only applies to agent definition fallback lists. Single
	// models, per-invocation overrides, and registry-less environments keep the
	// existing spawn-time resolution behavior exactly.
	if (!Array.isArray(models) || !registry) {
		const resolved = resolveModelWithFallbacks(models, parentProvider, registry, parentModel);
		return { ...resolved, skippedModels: [] };
	}

	const skippedModels: SkippedFallbackModel[] = [];
	let lastError = "";

	for (const modelStr of models) {
		if (signal?.aborted) return { ok: false, error: "Aborted before spawn", skippedModels };

		const resolved = resolveModelStringSingle(modelStr, parentProvider, registry);
		if (!resolved.ok) {
			lastError = resolved.error;
			const reason = compactErrorReason(resolved.error);
			skippedModels.push({ model: modelStr, reason });
			log.warn(`${logPrefix} Model "${modelStr}" unavailable (${reason}). Trying next fallback...`);
			continue;
		}

		const modelObj = resolved.provider ? registry.find(resolved.provider, resolved.modelId) : undefined;
		if (modelObj) {
			const probe = await probeModelAvailability(modelObj, { signal, registry });
			if (!probe.ok && probe.aborted) {
				return { ok: false, error: "Aborted before spawn", skippedModels };
			}
			if (signal?.aborted) return { ok: false, error: "Aborted before spawn", skippedModels };
			if (!probe.ok) {
				lastError = probe.reason;
				skippedModels.push({ model: modelStr, reason: probe.reason });
				log.warn(`${logPrefix} Model "${modelStr}" failed probe (${probe.reason}). Trying next fallback...`);
				continue;
			}
		}

		log.debug(`${logPrefix} Using model "${resolved.modelId}".`);
		return { ...resolved, skippedModels };
	}

	if (signal?.aborted) return { ok: false, error: "Aborted before spawn", skippedModels };

	if (parentModel) {
		const parentResolved = resolveModelStringSingle(parentModel, parentProvider, registry);
		if (parentResolved.ok) {
			const warning = `Agent preferred models were unavailable. Falling back to parent model "${parentResolved.modelId}".`;
			log.warn(`${logPrefix} ${warning}`);
			return { ...parentResolved, warning, skippedModels };
		}
		lastError = parentResolved.error;
	}

	return {
		ok: false,
		skippedModels,
		error: `None of the fallback models passed availability checks: ${[
			...models,
			...(parentModel ? [parentModel] : []),
		].join(", ")}. Last error: ${lastError || "all probes failed"}`,
	};
}

export function formatModelFallbackSummary(
	skippedModels: SkippedFallbackModel[],
	proposalModel: string | undefined,
	finalModel?: string,
): string | undefined {
	if (skippedModels.length === 0) return undefined;
	const skipped = skippedModels.map((s) => `- ${s.model}: ${s.reason}`).join("\n");
	const routeSummary =
		finalModel && finalModel !== proposalModel
			? `proposal resolved to "${proposalModel ?? "unknown"}" before arbitration selected "${finalModel}".`
			: `using "${finalModel ?? proposalModel ?? "unknown"}".`;
	return `[MODEL FALLBACK: skipped ${skippedModels.length} unavailable model(s); ${routeSummary}]\n${skipped}`;
}

export function prependModelFallbackSummary(
	output: string,
	skippedModels: SkippedFallbackModel[],
	proposalModel: string | undefined,
	finalModel?: string,
): string {
	const fallbackSummary = formatModelFallbackSummary(skippedModels, proposalModel, finalModel);
	return fallbackSummary ? `${fallbackSummary}\n\n${output}` : output;
}

function formatSkippedModelFailureDetails(skippedModels: SkippedFallbackModel[]): string | undefined {
	if (skippedModels.length === 0) return undefined;
	return `Skipped models:\n${skippedModels.map((s) => `- ${s.model}: ${s.reason}`).join("\n")}`;
}

const MAX_PARALLEL_TASKS = 8;
const MAX_TASK_LENGTH = 32_768; // 32 KB — prevent E2BIG from oversized argv

/**
 * Bounds the number of concurrently running background subagents. Ownership of the gate is kept
 * separate from the subagent tool definition so that a single logical session keeps one accurate
 * running-child count even when its tool definitions are rebuilt (e.g. on `/reload`).
 */
export interface SubagentConcurrencyGate {
	/** Resolves immediately if a slot is free, otherwise queues until one is released. */
	acquire(): Promise<void>;
	/** Returns a slot and wakes the next waiter, if any. */
	release(): void;
}

/**
 * Create a concurrency gate limited to `maxConcurrent` simultaneous holders. The count lives in
 * this closure, so a single gate instance shared across tool rebuilds keeps counting in-flight
 * children accurately, while distinct instances stay fully isolated from one another.
 */
export function createSubagentConcurrencyGate(maxConcurrent: number): SubagentConcurrencyGate {
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
		throw new Error("Subagent tool concurrency must be a positive whole number");
	}
	let running = 0;
	const waiters: Array<() => void> = [];
	return {
		acquire(): Promise<void> {
			if (running < maxConcurrent) {
				running++;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				waiters.push(() => {
					running++;
					resolve();
				});
			});
		},
		release(): void {
			running--;
			const next = waiters.shift();
			if (next) next();
		},
	};
}

/** Resolve per-task thinking precedence for parallel and chain modes. */
export function resolveSubagentThinkingOverride(
	taskThinking: ThinkingLevel | undefined,
	topLevelThinking: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	return taskThinking ?? topLevelThinking;
}

/**
 * Resolve a per-task cwd.
 * Accepts absolute paths as-is. Resolves relative paths against the parent cwd,
 * rejecting any that escape outside it.
 * Returns a result object with ok=false and an error string on rejection, so callers can surface it to the model.
 */
function clampCwd(defaultCwd: string, itemCwd?: string): { ok: true; cwd: string } | { ok: false; error: string } {
	if (!itemCwd) return { ok: true, cwd: defaultCwd };
	if (itemCwd.startsWith("/")) {
		return { ok: true, cwd: itemCwd };
	}
	const resolved = resolve(defaultCwd, itemCwd);
	if (resolved !== defaultCwd && !resolved.startsWith(`${defaultCwd}/`)) {
		return { ok: false, error: `Rejected cwd "${itemCwd}" — resolves outside parent cwd` };
	}
	return { ok: true, cwd: resolved };
}

export interface SubagentArbitrationHooks {
	arbitrate: (request: DispatchArbitrationRequest, signal?: AbortSignal) => Promise<DispatchArbitrationResult>;
	onRecord: (record: DispatchArbitrationRecord) => void;
	step?: number;
	defaultThinkingLevel?: ThinkingLevel;
	getAgentModelsForAgent?: (name: string) => string[] | undefined;
}

export async function executeSingle(
	agents: Map<string, AgentTypeConfig>,
	agentName: string | undefined,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	modelOverride?: string,
	parentProvider?: string,
	registry?: ModelRegistry,
	sessionDir?: string,
	parentModel?: string,
	agentModels?: string[],
	parentSessionFile?: string,
	onChildEvent?: (event: Record<string, unknown>) => void,
	thinkingOverride?: ThinkingLevel,
	arbitration?: SubagentArbitrationHooks,
	onControlAvailable?: (client: RpcClient | undefined) => void,
): Promise<SubagentResult> {
	let name = agentName || DEFAULT_AGENT;
	let config = agents.get(name);
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

	// Phase 1: resolve the parent's proposal with the existing precedence and
	// fallback behavior so the arbiter receives one concrete canonical route.
	const configuredModelSpec =
		modelOverride || (agentModels && agentModels.length > 0 ? agentModels : undefined) || config.model;
	const modelSpec = configuredModelSpec || parentModel;
	let effectiveConfig: AgentTypeConfig = modelOverride ? { ...config, model: modelOverride } : config;
	let resolvedProvider = parentProvider;
	let resolvedModel: Model<Api> | undefined;
	let warning: string | undefined;
	let skippedModels: SkippedFallbackModel[] = [];

	if (modelSpec) {
		const parentFallback = configuredModelSpec ? parentModel : undefined;
		const resolved = await resolveModelForSubagentSpawn(modelSpec, parentProvider, registry, parentFallback, signal);
		skippedModels = resolved.skippedModels;
		if (!resolved.ok) {
			const skippedDetails = formatSkippedModelFailureDetails(skippedModels);
			return {
				agent: name,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: skippedDetails ? `${resolved.error}\n\n${skippedDetails}` : resolved.error,
			};
		}
		effectiveConfig = { ...effectiveConfig, model: resolved.modelId };
		if (resolved.provider) resolvedProvider = resolved.provider;
		if (registry && resolvedProvider) resolvedModel = registry.find(resolvedProvider, resolved.modelId);
		warning = resolved.warning;
	}

	if (thinkingOverride && thinkingOverride !== "off" && !modelSpec) {
		return {
			agent: name,
			task,
			exitCode: 1,
			output: "",
			stderr: "",
			errorMessage: `Cannot validate thinking level "${thinkingOverride}" because agent "${name}" has no configured model and no parent model is available. Set a model on the agent or pass a per-call model override.`,
		};
	}

	const proposalModelId = Array.isArray(effectiveConfig.model) ? effectiveConfig.model[0] : effectiveConfig.model;
	const proposalSelectedModel = proposalModelId ? canonicalModelRef(resolvedProvider, proposalModelId) : undefined;
	let finalThinking = thinkingOverride;
	let arbitrationEnabled = false;
	if (arbitration) {
		const proposed: DispatchRoute = {
			agent: name,
			model: proposalSelectedModel ?? "",
			thinking: resolveEffectiveThinkingLevel(resolvedModel, thinkingOverride, arbitration.defaultThinkingLevel),
		};
		let arbitrationResult: DispatchArbitrationResult;
		try {
			arbitrationResult = await arbitration.arbitrate(
				{
					task,
					cwd,
					proposed,
					agents: summarizeAgentsForArbitration(agents, arbitration.getAgentModelsForAgent),
					parentSessionFile,
					step: arbitration.step,
				},
				signal,
			);
		} catch {
			const errorMessage = "Dispatch arbiter failed internally before child spawn.";
			try {
				arbitration.onRecord({
					status: "failure",
					proposed,
					final: null,
					changed: [],
					step: arbitration.step,
					errorCode: "internal_error",
					errorMessage,
				});
			} catch {}
			return {
				agent: name,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage,
			};
		}
		if (arbitrationResult.enabled) {
			arbitrationEnabled = true;
			if (!arbitrationResult.ok) {
				const record: DispatchArbitrationRecord = {
					status: "failure",
					proposed,
					final: null,
					changed: [],
					step: arbitration.step,
					errorCode: arbitrationResult.code,
					errorMessage: arbitrationResult.error,
				};
				try {
					arbitration.onRecord(record);
				} catch {
					// The original failure still prevents spawn; do not replace it with an observer error.
				}
				return {
					agent: name,
					task,
					exitCode: 1,
					output: "",
					stderr: "",
					errorMessage: `Dispatch arbitration failed: ${arbitrationResult.error}`,
				};
			}

			const decision = arbitrationResult.decision;
			const selectedConfig = agents.get(decision.agent);
			const slash = decision.model.indexOf("/");
			const selectedProvider = slash > 0 ? decision.model.slice(0, slash) : "";
			const selectedModelId = slash > 0 ? decision.model.slice(slash + 1) : "";
			const selectedModel = registry?.find(selectedProvider, selectedModelId);
			if (!selectedConfig || !selectedModel) {
				const errorMessage = !selectedConfig
					? "Arbiter selected an unknown agent."
					: "Arbiter selected an unavailable model.";
				const record: DispatchArbitrationRecord = {
					status: "failure",
					proposed,
					final: null,
					changed: [],
					step: arbitration.step,
					errorCode: !selectedConfig ? "unknown_agent" : "out_of_scope_model",
					errorMessage,
				};
				try {
					arbitration.onRecord(record);
				} catch {}
				return {
					agent: name,
					task,
					exitCode: 1,
					output: "",
					stderr: "",
					errorMessage: `Dispatch arbitration failed: ${errorMessage}`,
				};
			}

			const finalThinkingValidation = validateThinkingLevelForModel(selectedModel, decision.thinking);
			if (!finalThinkingValidation.ok) {
				const record: DispatchArbitrationRecord = {
					status: "failure",
					proposed,
					final: null,
					changed: [],
					step: arbitration.step,
					errorCode: "unsupported_thinking",
					errorMessage: finalThinkingValidation.error,
				};
				try {
					arbitration.onRecord(record);
				} catch {}
				return {
					agent: name,
					task,
					exitCode: 1,
					output: "",
					stderr: "",
					errorMessage: `Dispatch arbitration failed: ${finalThinkingValidation.error}`,
				};
			}

			name = decision.agent;
			config = selectedConfig;
			effectiveConfig = { ...config, model: selectedModel.id };
			resolvedProvider = selectedModel.provider;
			resolvedModel = selectedModel;
			finalThinking = decision.thinking;

			try {
				arbitration.onRecord({
					status: "success",
					proposed,
					final: decision,
					changed: arbitrationResult.changed,
					step: arbitration.step,
				});
			} catch (error) {
				return {
					agent: name,
					task,
					exitCode: 1,
					output: "",
					stderr: "",
					errorMessage: `Dispatch arbitration observability failed before spawn: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
	}

	if (finalThinking) {
		const validation = validateThinkingLevelForModel(resolvedModel, finalThinking);
		if (!validation.ok) {
			return {
				agent: name,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: validation.error,
			};
		}
	}

	const usedModel = effectiveConfig.model?.toString();
	onProgress?.(`Running ${name} agent${usedModel ? ` (${usedModel})` : ""}...`);
	const result = await spawnSubagent(
		effectiveConfig,
		task,
		cwd,
		signal,
		onProgress,
		resolvedProvider,
		sessionDir,
		parentSessionFile,
		onChildEvent,
		finalThinking,
		onControlAvailable,
	);
	const finalSelectedModel = result.model ?? (usedModel ? canonicalModelRef(resolvedProvider, usedModel) : undefined);
	result.output = prependModelFallbackSummary(
		result.output,
		skippedModels,
		arbitrationEnabled ? proposalSelectedModel : finalSelectedModel,
		arbitrationEnabled ? finalSelectedModel : undefined,
	);
	if (warning) {
		const warningContext = arbitrationEnabled ? `Proposal resolution: ${warning}` : warning;
		result.output = `[WARNING: ${warningContext}]\n\n${result.output}`;
	}
	return result;
}

async function executeChain(
	agents: Map<string, AgentTypeConfig>,
	chain: Array<{ agent?: string; task: string; cwd?: string; model?: string; thinking?: ThinkingLevel }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
	registry?: ModelRegistry,
	sessionBaseDir?: string,
	defaultAgent?: string,
	defaultModel?: string,
	defaultThinking?: ThinkingLevel,
	parentModel?: string,
	getAgentModelsForAgentFn?: (name: string) => string[] | undefined,
	parentSessionFile?: string,
	onChildEvent?: (event: Record<string, unknown>) => void,
	arbitration?: Omit<SubagentArbitrationHooks, "step">,
	onControlAvailable?: (client: RpcClient | undefined) => void,
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
				agent: step.agent || defaultAgent || DEFAULT_AGENT,
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
				agent: step.agent || defaultAgent || DEFAULT_AGENT,
				task,
				exitCode: 1,
				output: "",
				stderr: "",
				errorMessage: cwdResult.error,
			});
			break;
		}

		// Each chain step gets its own session subdirectory
		const stepSessionDir = sessionBaseDir ? join(sessionBaseDir, `step-${i + 1}`) : undefined;
		const stepAgentName = step.agent || defaultAgent || DEFAULT_AGENT;
		const stepMach6Models = getAgentModelsForAgentFn?.(stepAgentName);
		const result = await executeSingle(
			agents,
			step.agent || defaultAgent,
			task,
			cwdResult.cwd,
			signal,
			onProgress,
			step.model || defaultModel,
			parentProvider,
			registry,
			stepSessionDir,
			parentModel,
			stepMach6Models,
			parentSessionFile,
			onChildEvent,
			resolveSubagentThinkingOverride(step.thinking, defaultThinking),
			arbitration ? { ...arbitration, step: i + 1 } : undefined,
			onControlAvailable,
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
	/** Directory containing the agent's session JSONL file (known at spawn time). */
	sessionDir?: string;
	/** Path to the agent's session JSONL file (discovered when the child exits). */
	sessionFile?: string;
	/** Working directory the agent runs in. */
	cwd?: string;
	/** Safe host-generated pre-spawn routing decisions, ordered by chain step/attempt. */
	arbitrations?: DispatchArbitrationRecord[];
}

const backgroundAgentRegistry = new Map<string, BackgroundAgentInfo>();
const backgroundAbortControllers = new Map<string, AbortController>();
const backgroundControlClients = new Map<string, RpcClient>();

const REHYDRATED_AGENT_ID_PREFIX = "rehydrated-";
const HEADER_READ_CHUNK_BYTES = 8192;
const MAX_HEADER_READ_BYTES = 256 * 1024;
const METADATA_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isExpectedFilesystemError(err: unknown): boolean {
	return typeof (err as NodeJS.ErrnoException | undefined)?.code === "string";
}

function parseJsonlLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line);
		return isRecord(parsed) ? parsed : undefined;
	} catch (err) {
		if (err instanceof SyntaxError) return undefined;
		throw err;
	}
}

function readFirstNonEmptyLine(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const chunk = Buffer.alloc(HEADER_READ_CHUNK_BYTES);
		let buffered = "";
		let bytesReadTotal = 0;

		while (bytesReadTotal < MAX_HEADER_READ_BYTES) {
			const bytesRead = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_HEADER_READ_BYTES - bytesReadTotal), null);
			if (bytesRead === 0) break;
			bytesReadTotal += bytesRead;
			buffered += chunk.toString("utf8", 0, bytesRead);

			const lines = buffered.split(/\r?\n/);
			const completeLines = buffered.endsWith("\n") || buffered.endsWith("\r") ? lines : lines.slice(0, -1);
			for (const line of completeLines) {
				if (line.trim()) return line;
			}
			buffered = lines.at(-1) ?? "";
		}

		return buffered.trim() ? buffered : undefined;
	} catch (err) {
		if (isExpectedFilesystemError(err)) return undefined;
		throw err;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Best-effort observability: close errors are filesystem cleanup noise.
			}
		}
	}
}

function readFileSlice(filePath: string, start: number, length: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(length);
		const bytesRead = readSync(fd, buffer, 0, length, start);
		return buffer.toString("utf8", 0, bytesRead);
	} catch (err) {
		if (isExpectedFilesystemError(err)) return undefined;
		throw err;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Best-effort observability: close errors are filesystem cleanup noise.
			}
		}
	}
}

function readFileStart(filePath: string, maxBytes: number): string | undefined {
	let size = maxBytes;
	try {
		size = Math.min(statSync(filePath).size, maxBytes);
	} catch (err) {
		if (isExpectedFilesystemError(err)) return undefined;
		throw err;
	}
	return readFileSlice(filePath, 0, size);
}

function readFileTail(filePath: string, maxBytes: number): string | undefined {
	let start = 0;
	let length = maxBytes;
	try {
		const size = statSync(filePath).size;
		start = Math.max(0, size - maxBytes);
		length = size - start;
	} catch (err) {
		if (isExpectedFilesystemError(err)) return undefined;
		throw err;
	}
	return readFileSlice(filePath, start, length);
}

function parseSessionHeader(sessionFile: string): Record<string, unknown> | undefined {
	const headerLine = readFirstNonEmptyLine(sessionFile);
	if (!headerLine) return undefined;
	return parseJsonlLine(headerLine);
}

function comparablePath(pathValue: string): string {
	const resolved = resolve(pathValue);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parentSessionMatches(recordedParentSession: string, parentSessionFile: string): boolean {
	if (recordedParentSession === parentSessionFile) return true;
	if (comparablePath(recordedParentSession) === comparablePath(parentSessionFile)) return true;

	// Older/foreign invocations may disagree about absolute vs relative roots, but
	// dreb session filenames include a timestamp and UUID. A basename match is a
	// safe final fallback for recovering observability across process boundaries.
	return basename(recordedParentSession) === basename(parentSessionFile);
}

function extractTextFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;

	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
			parts.push(item.text.trim());
		}
	}
	const text = parts.join("\n").trim();
	return text || undefined;
}

function truncateTaskSummary(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function findFirstUserMessageSummary(sessionFile: string): string | undefined {
	const head = readFileStart(sessionFile, METADATA_READ_BYTES);
	if (!head) return undefined;

	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const entry = parseJsonlLine(line);
		if (entry?.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "user") continue;
		const text = extractTextFromContent(entry.message.content);
		if (text) return truncateTaskSummary(text);
	}
	return undefined;
}

function inferCompletedSessionStatus(sessionFile: string): "completed" | "failed" {
	const tail = readFileTail(sessionFile, TAIL_READ_BYTES);
	if (!tail) return "completed";

	const lines = tail.split(/\r?\n/).reverse();
	for (const line of lines) {
		if (!line.trim()) continue;
		const entry = parseJsonlLine(line);
		if (entry?.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "assistant") continue;

		const stopReason = entry.message.stopReason;
		return stopReason === "error" || stopReason === "aborted" ? "failed" : "completed";
	}
	return "completed";
}

function parseStartedAt(header: Record<string, unknown>, sessionFile: string): number {
	if (typeof header.timestamp === "string") {
		const timestamp = Date.parse(header.timestamp);
		if (Number.isFinite(timestamp)) return timestamp;
	}

	try {
		return statSync(sessionFile).mtime.getTime();
	} catch (err) {
		if (isExpectedFilesystemError(err)) return Date.now();
		throw err;
	}
}

function hasRegisteredSession(sessionDir: string, sessionFile: string): boolean {
	const comparableSessionDir = comparablePath(sessionDir);
	const comparableSessionFile = comparablePath(sessionFile);
	for (const agent of backgroundAgentRegistry.values()) {
		if (agent.sessionDir && comparablePath(agent.sessionDir) === comparableSessionDir) return true;
		if (agent.sessionFile && comparablePath(agent.sessionFile) === comparableSessionFile) return true;
	}
	return false;
}

/**
 * Best-effort recovery for completed background subagents after a dashboard/RPC
 * process resumes an existing parent session. Live background-agent state is an
 * in-memory registry, while child sessions are durable JSONL files under the
 * subagent sessions directory.
 *
 * Returns the number of newly registered agents. Expected filesystem and JSONL
 * parse failures are skipped; unexpected programming errors are allowed to throw.
 */
export function rehydrateBackgroundAgentsFromDisk(
	parentSessionFile: string | undefined,
	subagentSessionsBase = getSubagentSessionsDir(),
): number {
	if (!parentSessionFile) return 0;

	let entries: Dirent[];
	try {
		entries = readdirSync(subagentSessionsBase, { withFileTypes: true });
	} catch (err) {
		if (isExpectedFilesystemError(err)) return 0;
		throw err;
	}

	let registered = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const sessionDir = join(subagentSessionsBase, entry.name);
		const sessionFiles = discoverSessionFiles(sessionDir, entry.name);
		if (sessionFiles.length === 0) continue;

		let sessionFile: string | undefined;
		let header: Record<string, unknown> | undefined;
		for (const candidateFile of sessionFiles) {
			const candidateHeader = parseSessionHeader(candidateFile);
			if (candidateHeader?.type !== "session" || typeof candidateHeader.parentSession !== "string") continue;
			if (!parentSessionMatches(candidateHeader.parentSession, parentSessionFile)) continue;
			sessionFile = candidateFile;
			header = candidateHeader;
			break;
		}
		if (!sessionFile || !header) continue;

		const agentId = `${REHYDRATED_AGENT_ID_PREFIX}${entry.name}`;
		if (backgroundAgentRegistry.has(agentId) || hasRegisteredSession(sessionDir, sessionFile)) continue;

		const statusFile = sessionFiles[sessionFiles.length - 1] ?? sessionFile;
		const agentType = typeof header.agentType === "string" && header.agentType.trim() ? header.agentType : "agent";
		const taskSummary = findFirstUserMessageSummary(sessionFile) ?? `${agentType} (${entry.name})`;
		backgroundAgentRegistry.set(agentId, {
			agentId,
			agentType,
			taskSummary,
			startedAt: parseStartedAt(header, sessionFile),
			status: inferCompletedSessionStatus(statusFile),
			sessionDir,
			sessionFile,
			cwd: typeof header.cwd === "string" ? header.cwd : undefined,
		});
		registered++;
	}

	return registered;
}

function cloneBackgroundAgentInfo(info: BackgroundAgentInfo): BackgroundAgentInfo {
	return {
		...info,
		arbitrations: info.arbitrations?.map((record) => structuredClone(record)),
	};
}

/** Get a snapshot of all tracked background agents (running and recently completed). Returns readonly clones. */
export function getBackgroundAgents(): readonly Readonly<BackgroundAgentInfo>[] {
	return [...backgroundAgentRegistry.values()].map(cloneBackgroundAgentInfo);
}

/** Get only currently running background agents. Returns readonly clones. */
export function getRunningBackgroundAgents(): readonly Readonly<BackgroundAgentInfo>[] {
	return [...backgroundAgentRegistry.values()].filter((a) => a.status === "running").map(cloneBackgroundAgentInfo);
}

function getBackgroundControlClient(agentId: string): RpcClient {
	const info = backgroundAgentRegistry.get(agentId);
	if (!info) throw new Error(`Unknown background agent "${agentId}".`);
	if (info.status !== "running") throw new Error(`Background agent "${agentId}" is no longer running.`);
	const client = backgroundControlClients.get(agentId);
	if (!client) throw new Error(`Background agent "${agentId}" has not started a controllable child yet.`);
	return client;
}

/** Queue the user's message unchanged in the selected live child session. */
export async function steerBackgroundAgent(agentId: string, message: string): Promise<void> {
	await getBackgroundControlClient(agentId).steer(message);
}

/** Read pending steering messages and the effective delivery mode from the selected live child. */
export async function getBackgroundAgentPendingSteering(
	agentId: string,
): Promise<{ steeringMode: "all" | "one-at-a-time"; pending: RpcPendingMessages }> {
	const client = getBackgroundControlClient(agentId);
	const [state, pending] = await Promise.all([client.getState(), client.getPendingMessages()]);
	return { steeringMode: state.steeringMode, pending };
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
	backgroundControlClients.clear();
}

/** Remove completed/failed entries older than the given age (ms). Default: 5 minutes. */
export function pruneBackgroundAgents(maxAgeMs = 5 * 60 * 1000): void {
	const now = Date.now();
	for (const [id, info] of backgroundAgentRegistry) {
		if (info.status !== "running" && now - info.startedAt > maxAgeMs) {
			backgroundAgentRegistry.delete(id);
			backgroundAbortControllers.delete(id);
			backgroundControlClients.delete(id);
		}
	}
}

export interface SubagentToolOptions {
	/** Called when a background subagent starts. Used by TUI to show status indicators. */
	onBackgroundStart?: (agentId: string, agentType: string, taskSummary: string, sessionDir?: string) => void;
	/** Called when a background subagent completes with its result. `cancelled` is true if the user aborted it. */
	onBackgroundComplete?: (agentId: string, result: SubagentResult, cancelled: boolean) => void;
	/**
	 * Called with every JSONL event a background child process emits, tagged with the
	 * child's agentId. Enables live observability relays (e.g. the dashboard) without
	 * tailing session files. Chain steps share the chain's agentId.
	 */
	onBackgroundEvent?: (agentId: string, event: Record<string, unknown>) => void;
	/** Parent session's current provider (e.g. "anthropic"). Called at each invocation to get the live value after mid-session model switches. */
	parentProvider?: () => string | undefined;
	/** Parent session's current model ID. Used as a final fallback when all subagent-configured models fail to resolve. Called at each invocation for fresh value. */
	parentModel?: () => string | undefined;
	/** Parent session's current session file path. Used to link subagent child sessions back to their parent session. */
	parentSessionFile?: () => string | undefined;
	/** Model registry for validating model names before spawning child processes. */
	modelRegistry?: ModelRegistry;
	/** Settings-based model override getter for mach6.models. */
	getAgentModelsForAgent?: (agentName: string) => string[] | undefined;
	/** Mode-independent headless arbitration callback. Disabled arbitration returns `{ enabled: false }`. */
	arbitrate?: (request: DispatchArbitrationRequest, signal?: AbortSignal) => Promise<DispatchArbitrationResult>;
	/** Persist and relay one safe host-generated record for each enabled arbitration attempt. */
	onArbitration?: (event: SubagentArbitrationEvent) => void;
	/** Effective default used to make an omitted proposed thinking level concrete for the arbiter. */
	defaultThinkingLevel?: () => ThinkingLevel;
	/**
	 * Maximum children this parent tool instance may run concurrently. Must be at least one.
	 * Used for the model-visible description and, when `concurrencyGate` is omitted, to size a
	 * fresh per-instance gate.
	 */
	maxConcurrentSubagents?: number;
	/**
	 * Externally owned concurrency gate. Supply this so the running-child count survives tool
	 * definition rebuilds (e.g. on `/reload`); without it the tool creates its own gate sized by
	 * `maxConcurrentSubagents`, which resets to zero each time the tool is recreated.
	 */
	concurrencyGate?: SubagentConcurrencyGate;
}

// ---------------------------------------------------------------------------
// Tool schema and definition
// ---------------------------------------------------------------------------

const thinkingLevelSchema = Type.Union(
	[
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	],
	{ description: "Thinking level override for the child model." },
);

const taskItemSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (default: 'Explore')" })),
	task: Type.String({ description: "The task prompt for this subagent" }),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory (defaults to parent's cwd). Accepts absolute paths or relative paths within parent's cwd.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for this task. Takes precedence over agent definition model. Note: a single-string override discards the agent's fallback list.",
		}),
	),
	thinking: Type.Optional(thinkingLevelSchema),
});

const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent type name (default: 'Explore')" })),
	task: Type.Optional(Type.String({ description: "Task prompt (single mode)", minLength: 1 })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override. Takes precedence over agent definition model. Note: a single-string override discards the agent's fallback list. For parallel/chain, set per-task instead.",
		}),
	),
	thinking: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{
				description:
					"Thinking level override. Per-task values take precedence in parallel and chain modes. Omit to preserve child defaults.",
			},
		),
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
	// background parameter removed — all subagents run in background mode.
	// Kept in schema for backward compatibility (silently ignored if passed).
	background: Type.Optional(
		Type.Boolean({ description: "Deprecated — all subagents run in background mode. This parameter is ignored." }),
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
	argsComplete = true,
): string {
	const invalidArg = invalidArgText(theme);

	if (args?.tasks) {
		// Show agent type(s) in the parallel label
		const agentCounts = new Map<string, number>();
		for (const t of args.tasks) {
			const name = t.agent || args.agent || DEFAULT_AGENT;
			agentCounts.set(name, (agentCounts.get(name) || 0) + 1);
		}
		let typeLabel: string;
		if (agentCounts.size === 1) {
			const [name] = [...agentCounts.keys()];
			typeLabel = `${args.tasks.length} ${name} tasks`;
		} else {
			const parts = [...agentCounts.entries()].map(([name, count]) => `${count} ${name}`);
			typeLabel = `${args.tasks.length} tasks: ${parts.join(", ")}`;
		}
		return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `parallel (${typeLabel})`)}`;
	}
	if (args?.chain) {
		const agentName = str(args.agent) || args.chain[0]?.agent || DEFAULT_AGENT;
		return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `chain (${agentName}, ${args.chain.length} steps)`)}`;
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
		(taskPreview === null
			? argsComplete
				? invalidArg
				: theme.fg("muted", "…")
			: theme.fg("toolOutput", `"${taskPreview}"`))
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

export function formatSingleResult(result: SubagentResult): string {
	const metadata = [
		result.model ? `model: ${result.model}` : undefined,
		result.thinking ? `thinking: ${result.thinking}` : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join(", ");
	let text = `## Agent: ${result.agent}${metadata ? ` (${metadata})` : ""}\n`;
	if (result.exitCode !== 0) {
		text += `**Error** (exit ${result.exitCode}): ${result.errorMessage || "Unknown error"}\n`;
		if (result.stderr) {
			text += `\nStderr:\n${result.stderr}\n`;
		}
	} else if (result.errorMessage) {
		// Clean exit but an error was surfaced (e.g. truncation at the token limit).
		text += `**Error**: ${result.errorMessage}\n`;
	}
	if (result.output) {
		text += `\n${result.output}`;
	} else if (result.exitCode === 0 && !result.errorMessage) {
		text += "\n(No output)";
	}
	if (result.sessionFile) {
		text += `\n\nSession log: ${result.sessionFile}`;
	}
	return text;
}

export function createSubagentToolDefinition(
	cwd: string,
	options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails | undefined> {
	const onBackgroundStart = options?.onBackgroundStart;
	const onBackgroundComplete = options?.onBackgroundComplete;
	const onBackgroundEvent = options?.onBackgroundEvent;
	const getParentProvider = options?.parentProvider ?? (() => undefined);
	const getParentModel = options?.parentModel ?? (() => undefined);
	const getParentSessionFile = options?.parentSessionFile ?? (() => undefined);
	const modelRegistry = options?.modelRegistry;
	const getAgentModelsForAgent = options?.getAgentModelsForAgent;
	const arbitrate = options?.arbitrate;
	const onArbitration = options?.onArbitration;
	const getDefaultThinkingLevel = options?.defaultThinkingLevel;
	const maxConcurrentSubagents = options?.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS;
	if (!Number.isSafeInteger(maxConcurrentSubagents) || maxConcurrentSubagents < 1) {
		throw new Error("Subagent tool concurrency must be a positive whole number");
	}

	// The concurrency gate is owned by the caller (e.g. AgentSession) so that it survives
	// runtime rebuilds/reloads: the tool definition is recreated on every `/reload`, but the
	// gate must keep counting in-flight children launched before the reload. When no gate is
	// supplied (external SDK callers, tests) the tool owns a fresh per-instance gate, which
	// still keeps separately embedded sessions from coupling through module-global state.
	const concurrencyGate = options?.concurrencyGate ?? createSubagentConcurrencyGate(maxConcurrentSubagents);
	const acquireBackgroundSlot = (): Promise<void> => concurrencyGate.acquire();
	const releaseBackgroundSlot = (): void => concurrencyGate.release();

	// Discover agents at definition time to build the prompt guidelines.
	// This is cheap (reads .md files) and the same call happens on every execute().
	const knownAgents = discoverAgentTypes(cwd);
	const agentListParts: string[] = [];
	for (const [name, config] of knownAgents) {
		const defaultTag = name === DEFAULT_AGENT ? " (default)" : "";
		const desc = config.description || name;
		agentListParts.push(`'${name}'${defaultTag} — ${desc}`);
	}
	const builtInAgentsLine = `Built-in agents: ${agentListParts.join("; ")}`;

	return {
		name: "subagent",
		label: "subagent",
		description:
			"Run focused, independent work in a child agent when the task matches that agent's defined role " +
			"(Explore for concrete evidence gathering, Sandbox for isolated /tmp-only analysis). " +
			`Supports \`task\` for a single task, \`tasks\` for parallel execution in one call (up to 8, max ${maxConcurrentSubagents} concurrent), ` +
			"and `chain` for a sequential pipeline with {previous} substitution. " +
			"All subagents run in background — returns immediately, notifies on completion.",
		promptSnippet: "Run role-matched work in independent child agents",
		promptGuidelines: [
			"`subagent` can be used for focused, independent work that matches a child agent's defined role; delegation is optional, not an unconditional default",
			"When `agent` is omitted, the default is `Explore`. Default Explore is for concrete, bounded evidence gathering: locating files, symbols, or documentation; enumerating call sites; quoting exact snippets; and tracing an explicit data flow",
			"Do not ask default Explore to diagnose root causes, interpret ambiguous requirements, make architecture or design decisions, recommend an implementation, or produce an implementation plan. The primary agent must synthesize Explore evidence and own those conclusions",
			"Good default Explore tasks: find every file that renders a named component; list tests for a specific behavior; quote code that limits a collection; locate documented examples; enumerate call sites. Bad default Explore tasks: investigate a root cause; decide ambiguous behavior; recommend an implementation; design an architecture or refactor; produce an implementation plan",
			"Parallel and chain modes do not make a role-inappropriate task suitable for default Explore. Specialized agents may perform the broader work described by their own definitions",
			"Available agent types can be discovered from ~/.dreb/agents/ and .dreb/agents/ markdown files",
			builtInAgentsLine,
			'Use the `tasks` array to run multiple independent, role-matched tasks in a single `subagent` call (parallel mode), not separate calls. Typical mach6-review batch: `{ "tasks": [{ "agent": "code-reviewer", "task": "Review code changes" }, { "agent": "error-auditor", "task": "Audit runtime failures" }, { "agent": "test-reviewer", "task": "Review test coverage" }, { "agent": "completeness-checker", "task": "Check issue completeness" }] }`',
			"Use chain mode for role-matched steps when each step depends on the previous step's output (reference with {previous})",
			"All subagents run in background — the tool returns immediately and you are notified when each agent completes.",
			"Subagents have their own context window — provide enough context in the task prompt",
			"Each agent notifies independently when done — completion messages include a list of any still-running agents. If you need their results before proceeding, end your current turn with no tool calls (as if you were asking the user a question and waiting for their reply). This emits `agent_end` and lets the framework deliver the completion as a new message that resumes your turn automatically. Do not call `sleep` or any other waiting action, and do not launch filler work.",
			"Agent definitions specify a `model` field with a provider fallback list (comma-separated or YAML list). The spawner tries each in order and uses the first one that resolves for the current provider. This makes agents portable across providers.",
			"Per-invocation `model` overrides take precedence but **discard the entire fallback list** — if the single override model isn't available on the current provider, the agent fails. Only override when you have a specific reason (e.g. escalating to a stronger tier for a complex task).",
			"Optional `thinking` overrides accept off/minimal/low/medium/high/xhigh/max. Per-task values override a top-level value; unsupported levels fail before spawn. Omit thinking to preserve the child's configured default.",
			"**Model routing** — choose an agent by role fit first. Agent definitions already specify the normal model tier for that role; override the model only when the assigned task genuinely requires a different capability tier.",
			"**Model identity** — Your current model is stated in the system prompt as `You are running on: provider/id`. Use this for explicit routing decisions — e.g. delegate vision tasks if you're on a text-only model, or use a differently-architected model as a critic for tasks where diverse model perspectives improve reliability.",
		],
		parameters: subagentSchema,

		async execute(_toolCallId, params: SubagentToolInput, _signal, _onUpdate) {
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

			// All subagents run in background mode — return immediately, notify on completion
			{
				if (!onBackgroundComplete) {
					return {
						content: [
							{
								type: "text",
								text: "Subagent execution requires background support, which is not available in this session.",
							},
						],
						details: undefined,
					};
				}

				/**
				 * Shared lifecycle for all background launches: generates agent ID,
				 * sets up registry/abort/notification, gates on the concurrency
				 * semaphore, and handles errors. The caller provides the actual
				 * work via `runFn(signal, onChildEvent, onArbitrationRecord)` which must
				 * return a SubagentResult. Child events are relayed live; arbitration
				 * records update the registry before being persisted/emitted.
				 */
				const launchBackgroundLifecycle = (
					agentName: string,
					taskSummary: string,
					sessionDir: string,
					agentCwd: string,
					runFn: (
						signal: AbortSignal,
						onChildEvent: ((event: Record<string, unknown>) => void) | undefined,
						onArbitrationRecord: (record: DispatchArbitrationRecord) => void,
						onControlAvailable: (client: RpcClient | undefined) => void,
					) => Promise<SubagentResult>,
				): string => {
					const agentId = generateAgentId();
					const bgAbort = new AbortController();
					backgroundAgentRegistry.set(agentId, {
						agentId,
						agentType: agentName,
						taskSummary,
						startedAt: Date.now(),
						status: "running",
						sessionDir,
						cwd: agentCwd,
					});
					backgroundAbortControllers.set(agentId, bgAbort);
					onBackgroundStart?.(agentId, agentName, taskSummary, sessionDir);

					// Relay child JSONL events tagged with this agent's ID. Guarded so a
					// throwing relay listener can never kill the stdout reader.
					const onChildEvent = onBackgroundEvent
						? (event: Record<string, unknown>) => {
								try {
									onBackgroundEvent(agentId, event);
								} catch (err) {
									log.warn(
										`[subagent] onBackgroundEvent threw for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
									);
								}
							}
						: undefined;

					const onArbitrationRecord = (record: DispatchArbitrationRecord) => {
						const entry = backgroundAgentRegistry.get(agentId);
						if (entry) {
							entry.arbitrations ??= [];
							entry.arbitrations.push(record);
							if (record.status === "success" && record.final) entry.agentType = record.final.agent;
						}
						onArbitration?.({ type: "subagent_arbitration", agentId, ...record });
					};

					const bgSignal = bgAbort.signal;
					const onControlAvailable = (client: RpcClient | undefined) => {
						if (client) backgroundControlClients.set(agentId, client);
						else backgroundControlClients.delete(agentId);
					};

					const safeNotify = (result: SubagentResult) => {
						try {
							onBackgroundComplete(agentId, result, bgSignal.aborted);
						} catch (err) {
							log.warn(
								`[subagent] onBackgroundComplete threw for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}. Background result lost.`,
							);
						}
					};

					const run = async () => {
						await acquireBackgroundSlot();
						try {
							const result = await runFn(bgSignal, onChildEvent, onArbitrationRecord, onControlAvailable);
							const entry = backgroundAgentRegistry.get(agentId);
							if (entry && !bgSignal.aborted) entry.status = result.exitCode === 0 ? "completed" : "failed";
							if (entry && result.sessionFile) entry.sessionFile = result.sessionFile;
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
						} finally {
							backgroundControlClients.delete(agentId);
							releaseBackgroundSlot();
						}
					};
					run().catch((err) => {
						log.warn(
							`[subagent] Unhandled background error (${agentId}): ${err instanceof Error ? err.message : String(err)}`,
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
							log.error(
								`[subagent] CRITICAL: Last-resort notification failed for ${agentId}: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
							);
						}
					});

					return agentId;
				};

				// Helper to launch a single background task
				const subagentSessionsBase = getSubagentSessionsDir();
				const launchBackgroundTask = (
					agentName: string,
					task: string,
					taskLabel: string,
					taskCwd?: string,
					modelOverride?: string,
					thinkingOverride?: ThinkingLevel,
				) => {
					const resolvedCwd = taskCwd ?? cwd;
					// Each background agent gets its own session subdirectory
					const sessionId = generateAgentId();
					const sessionDir = join(subagentSessionsBase, sessionId);
					const agentModels = getAgentModelsForAgent?.(agentName || DEFAULT_AGENT);
					return launchBackgroundLifecycle(
						agentName,
						taskLabel,
						sessionDir,
						resolvedCwd,
						(signal, onChildEvent, onArbitrationRecord, onControlAvailable) =>
							executeSingle(
								agents,
								agentName === DEFAULT_AGENT ? undefined : agentName,
								task,
								resolvedCwd,
								signal,
								undefined,
								modelOverride,
								getParentProvider(),
								modelRegistry,
								sessionDir,
								getParentModel(),
								agentModels,
								getParentSessionFile(),
								onChildEvent,
								thinkingOverride,
								arbitrate
									? {
											arbitrate,
											onRecord: onArbitrationRecord,
											defaultThinkingLevel: getDefaultThinkingLevel?.(),
											getAgentModelsForAgent,
										}
									: undefined,
								onControlAvailable,
							),
					);
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
						params.thinking,
					);
					return {
						content: [
							{
								type: "text",
								text: `Background agent ${agentId} started (${agentName}). You will be notified when it completes.`,
							},
						],
						details: { mode: "single", agentCount: 1 } as SubagentToolDetails,
						endTurn: true,
					};
				} else if (params.tasks) {
					// Parallel background tasks — each gets its own agent ID and notifies independently
					const launched: Array<{ id: string; agentName: string; taskText: string }> = [];
					const skipped: Array<{ taskText: string; error: string }> = [];
					for (let i = 0; i < params.tasks.length; i++) {
						const item = params.tasks[i];
						const agentName = item.agent || params.agent || DEFAULT_AGENT;
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
							item.model || params.model,
							resolveSubagentThinkingOverride(item.thinking, params.thinking),
						);
						launched.push({ id: agentId, agentName, taskText: item.task });
					}
					const listing = launched
						.map(({ id, agentName, taskText }) => `  ${id} (${agentName}): ${taskText.slice(0, 80)}`)
						.join("\n");
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
						endTurn: launched.length > 0,
					};
				} else {
					// Chain mode — sequential, stays as one agent since steps depend on each other
					const agentName = params.agent || params.chain![0].agent || DEFAULT_AGENT;
					const taskSummary = `${params.chain!.length}-step chain`;
					const chainSteps = params.chain!;

					const chainSessionDir = join(subagentSessionsBase, `chain-${generateAgentId()}`);
					const agentId = launchBackgroundLifecycle(
						agentName,
						taskSummary,
						chainSessionDir,
						cwd,
						async (signal, onChildEvent, onArbitrationRecord, onControlAvailable) => {
							const results = await executeChain(
								agents,
								chainSteps,
								cwd,
								signal,
								undefined,
								getParentProvider(),
								modelRegistry,
								chainSessionDir,
								params.agent,
								params.model,
								params.thinking,
								getParentModel(),
								getAgentModelsForAgent,
								getParentSessionFile(),
								onChildEvent,
								arbitrate
									? {
											arbitrate,
											onRecord: onArbitrationRecord,
											defaultThinkingLevel: getDefaultThinkingLevel?.(),
											getAgentModelsForAgent,
										}
									: undefined,
								onControlAvailable,
							);
							const resultText = results
								.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`)
								.join("\n\n---\n\n");
							const failed = results.filter((r) => r.exitCode !== 0);
							// Per-step session logs are already embedded in resultText via formatSingleResult
							return {
								agent: agentName,
								task: taskSummary,
								steps: results.map((result, index) => ({
									step: index + 1,
									agent: result.agent,
									success: result.exitCode === 0,
									model: result.model,
									thinking: result.thinking,
								})),
								exitCode: failed.length > 0 ? 1 : 0,
								output: resultText,
								stderr: "",
								errorMessage:
									failed.length > 0
										? `Chain stopped at step ${results.length} of ${chainSteps.length}: ${results[results.length - 1]?.errorMessage}`
										: null,
							};
						},
					);

					return {
						content: [
							{
								type: "text",
								text: `Background chain ${agentId} started (${taskSummary}). You will be notified when it completes.`,
							},
						],
						details: { mode: "chain", agentCount: chainSteps.length } as SubagentToolDetails,
						endTurn: true,
					};
				}
			}
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatSubagentCall(args, theme, context.argsComplete));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
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
