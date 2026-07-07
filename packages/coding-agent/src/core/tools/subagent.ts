import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@dreb/agent-core";
import { type Api, type AssistantMessage, type Context, completeSimple, type Model } from "@dreb/ai";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { CONFIG_DIR_NAME, getPackageDir, getSubagentSessionsDir } from "../../config.js";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { attachJsonlLineReader } from "../../modes/rpc/jsonl.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { log } from "../logger.js";
import type { ModelRegistry } from "../model-registry.js";
import { resolveCliModel } from "../model-resolver.js";
import { resolveEffectiveThinkingLevel, thinkingLevelToReasoning } from "../thinking.js";
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

export interface SubagentResult {
	agent: string;
	task: string;
	model?: string;
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
// never no-op; they have a task to complete), subagent (no recursive spawning),
// and suggest_next (would end the subagent's turn mid-work).
const SUBAGENT_EXCLUDED_TOOLS = ["wait", "subagent", "suggest_next"] as const;

// Default standard tools for subagents when no tools are specified in the agent
// definition. This is the set passed via --tools to the child process.
//
// NOTE: Always-active tools (search, skill, tasks_update) are NOT listed here —
// the child process adds them unconditionally regardless of --tools.
// Internal tools (tmp_read) are also excluded.
const SUBAGENT_DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search", "web_fetch"];

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
	/** Called when the child reports its resolved model (`agent_start`). */
	onModel: (modelId: string) => void;
	/** Called with lines that failed to parse as JSON (often real startup errors). */
	onPlainLine: (line: string) => void;
	/** Mutable holder for the last tool name, shared across lines for progress text. */
	toolNameRef: { current: string };
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
	if (event.type === "agent_start" && event.model) {
		sinks.onModel(event.model.id);
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
		// When the model string doesn't already specify a provider (no "/"),
		// inherit the parent's provider to prevent fuzzy matching from picking
		// an unauthenticated provider (e.g. Bedrock instead of Anthropic).
		if (parentProvider && !modelStr.includes("/")) {
			args.push("--provider", parentProvider);
		}
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
		const toolNameRef = { current: "" };
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
			log.warn(`[subagent] stderr stream error (agent=${agentConfig.name}): ${err.message}`);
		});

		// Parse JSONL events from stdout
		if (proc.stdout) {
			proc.stdout.on("error", (err) => {
				log.warn(`[subagent] stdout stream error (agent=${agentConfig.name}): ${err.message}`);
			});
			attachJsonlLineReader(proc.stdout, (line) => {
				handleChildJsonlLine(line, {
					onEvent: onChildEvent,
					onAssistantMessage: (message) => collectedMessages.push(message),
					onProgress,
					onModel: (modelId) => {
						resolvedModel = modelId;
					},
					onPlainLine: (plain) => plainStdoutLines.push(plain),
					toolNameRef,
				});
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
					stderrTrimmed.slice(0, 500) || plainOutput.slice(0, 500) || `Subagent exited with code ${exitCode}`;
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

			resolvePromise({
				agent: agentConfig.name,
				task,
				model:
					resolvedModel ??
					(exitCode === 0
						? Array.isArray(agentConfig.model)
							? agentConfig.model[0]
							: agentConfig.model
						: undefined),
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

/**
 * Find the most recently modified .jsonl file in a session directory.
 * Returns the full path, or undefined if no session file was written
 * (e.g., subagent was killed before the first assistant message).
 */
export function discoverSessionFile(sessionDir: string, agentName: string): string | undefined {
	try {
		if (!existsSync(sessionDir)) return undefined;
		const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
		if (files.length === 0) return undefined;
		// Pick the most recently modified file (typically there's only one per subagent dir)
		let best: { path: string; mtime: number } | undefined;
		for (const f of files) {
			try {
				const fullPath = join(sessionDir, f);
				const mtime = statSync(fullPath).mtime.getTime();
				if (!best || mtime > best.mtime) {
					best = { path: fullPath, mtime };
				}
			} catch {
				// File disappeared or is a bad symlink — skip it, keep any valid candidate
			}
		}
		if (best) {
			log.debug(`[subagent] session file: ${best.path} (agent=${agentName})`);
			return best.path;
		}
	} catch (err) {
		log.warn(
			`[subagent] failed to discover session file (agent=${agentName}): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return undefined;
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
	selectedModel: string | undefined,
): string | undefined {
	if (skippedModels.length === 0) return undefined;
	const skipped = skippedModels.map((s) => `- ${s.model}: ${s.reason}`).join("\n");
	return `[MODEL FALLBACK: skipped ${skippedModels.length} unavailable model(s); using "${selectedModel ?? "unknown"}".]\n${skipped}`;
}

export function prependModelFallbackSummary(
	output: string,
	skippedModels: SkippedFallbackModel[],
	selectedModel: string | undefined,
): string {
	const fallbackSummary = formatModelFallbackSummary(skippedModels, selectedModel);
	return fallbackSummary ? `${fallbackSummary}\n\n${output}` : output;
}

function formatSkippedModelFailureDetails(skippedModels: SkippedFallbackModel[]): string | undefined {
	if (skippedModels.length === 0) return undefined;
	return `Skipped models:\n${skippedModels.map((s) => `- ${s.model}: ${s.reason}`).join("\n")}`;
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
	// Per-invocation model override takes precedence over agent settings, which take precedence over agent definition model.
	// Override is always a single string; agentModels and agent config may be arrays.
	const modelSpec = modelOverride || (agentModels && agentModels.length > 0 ? agentModels : undefined) || config.model;
	let effectiveConfig: AgentTypeConfig = modelOverride ? { ...config, model: modelOverride } : config;
	let resolvedProvider = parentProvider;
	let warning: string | undefined;
	let skippedModels: SkippedFallbackModel[] = [];

	// Resolve and validate the model against the registry before spawning.
	// This catches typos and invalid model names immediately instead of failing
	// silently in the child process. Also passes the canonical model ID to the
	// child, avoiding fuzzy matching entirely. Agent definition fallback lists get
	// an additional best-effort 1-token probe before spawn so runtime-unavailable
	// models are skipped before committing to a child process.
	if (modelSpec) {
		const resolved = await resolveModelForSubagentSpawn(modelSpec, parentProvider, registry, parentModel, signal);
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
		if (resolved.provider) {
			resolvedProvider = resolved.provider;
		}
		warning = resolved.warning;
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
	);
	result.output = prependModelFallbackSummary(result.output, skippedModels, result.model ?? usedModel);
	if (warning) {
		result.output = `[WARNING: ${warning}]\n\n${result.output}`;
	}
	return result;
}

async function executeChain(
	agents: Map<string, AgentTypeConfig>,
	chain: Array<{ agent?: string; task: string; cwd?: string; model?: string }>,
	defaultCwd: string,
	signal?: AbortSignal,
	onProgress?: (event: string) => void,
	parentProvider?: string,
	registry?: ModelRegistry,
	sessionBaseDir?: string,
	defaultAgent?: string,
	defaultModel?: string,
	parentModel?: string,
	getAgentModelsForAgentFn?: (name: string) => string[] | undefined,
	parentSessionFile?: string,
	onChildEvent?: (event: Record<string, unknown>) => void,
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
}

// ---------------------------------------------------------------------------
// Tool schema and definition
// ---------------------------------------------------------------------------

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
	let text = `## Agent: ${result.agent}${result.model ? ` (model: ${result.model})` : ""}\n`;
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
			"Delegate tasks to independent subagents (Explore for codebase research, Sandbox for isolated /tmp-only analysis). " +
			"Supports single task, parallel (up to 8, max 4 concurrent), " +
			"and chain (sequential pipeline with {previous} substitution) modes. " +
			"All subagents run in background — returns immediately, notifies on completion.",
		promptSnippet: "Delegate tasks to independent subagents",
		promptGuidelines: [
			"Use `subagent` to delegate focused, independent tasks to child agents",
			"Available agent types can be discovered from ~/.dreb/agents/ and .dreb/agents/ markdown files",
			builtInAgentsLine,
			"Use parallel mode for independent tasks that can run concurrently",
			"Use chain mode when each step depends on the previous step's output (reference with {previous})",
			"All subagents run in background — the tool returns immediately and you are notified when each agent completes.",
			"Subagents have their own context window — provide enough context in the task prompt",
			"Each agent notifies independently when done — completion messages include a list of any still-running agents. If you need their results before proceeding, end your current turn with no tool calls (as if you were asking the user a question and waiting for their reply). This emits `agent_end` and lets the framework deliver the completion as a new message that resumes your turn automatically. Do not call `sleep` or any other waiting action, and do not launch filler work.",
			"Agent definitions specify a `model` field with a provider fallback list (comma-separated or YAML list). The spawner tries each in order and uses the first one that resolves for the current provider. This makes agents portable across providers.",
			"Per-invocation `model` overrides take precedence but **discard the entire fallback list** — if the single override model isn't available on the current provider, the agent fails. Only override when you have a specific reason (e.g. escalating to a stronger tier for a complex task).",
			"**Model routing** — agent definitions already specify the right tier for their role. Most subagent tasks (exploration, file discovery, grep, navigation, summarization) are handled well by the defaults. Do not override the model unless the task genuinely requires a different capability tier than what the agent definition provides.",
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
				 * work via `runFn(signal, onChildEvent)` which must return a
				 * SubagentResult; `onChildEvent` (when defined) must be forwarded to
				 * the spawn so the child's JSONL events reach the relay.
				 */
				const launchBackgroundLifecycle = (
					agentName: string,
					taskSummary: string,
					sessionDir: string,
					agentCwd: string,
					runFn: (
						signal: AbortSignal,
						onChildEvent?: (event: Record<string, unknown>) => void,
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

					const bgSignal = bgAbort.signal;

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
						await bgAcquire();
						try {
							const result = await runFn(bgSignal, onChildEvent);
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
							bgRelease();
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
				) => {
					const resolvedCwd = taskCwd ?? cwd;
					// Each background agent gets its own session subdirectory
					const sessionId = generateAgentId();
					const sessionDir = join(subagentSessionsBase, sessionId);
					const agentModels = getAgentModelsForAgent?.(agentName || DEFAULT_AGENT);
					return launchBackgroundLifecycle(agentName, taskLabel, sessionDir, resolvedCwd, (signal, onChildEvent) =>
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
						async (signal, onChildEvent) => {
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
								getParentModel(),
								getAgentModelsForAgent,
								getParentSessionFile(),
								onChildEvent,
							);
							const resultText = results
								.map((r, i) => `### Step ${i + 1}\n${formatSingleResult(r)}`)
								.join("\n\n---\n\n");
							const failed = results.filter((r) => r.exitCode !== 0);
							// Per-step session logs are already embedded in resultText via formatSingleResult
							return {
								agent: agentName,
								task: taskSummary,
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
