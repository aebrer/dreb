/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { basename } from "node:path";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../../cli/args.js";
import { VERSION } from "../../config.js";
import type { AgentSession } from "../../core/agent-session.js";
import { DailyCostTracker } from "../../core/daily-cost-tracker.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { getGitBranch } from "../../core/git-branch.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import { parseModelPattern } from "../../core/model-resolver.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import type { SessionInfo, SessionTreeNode } from "../../core/session-manager.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager, TransportSetting } from "../../core/settings-manager.js";
import { TabTitleGenerator } from "../../core/tab-title.js";
import {
	type BackgroundAgentInfo,
	discoverAgentTypes,
	getBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
} from "../../core/tools/subagent.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPendingMessages,
	RpcResources,
	RpcResponse,
	RpcScopedModel,
	RpcSessionInfo,
	RpcSessionState,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

/**
 * Map a core {@link SessionInfo} to the RPC DTO, converting Date fields to ISO strings.
 * Shared by the `list_sessions` and `list_all_sessions` handlers so their shapes cannot drift.
 */
export function toRpcSessionInfo(s: SessionInfo): RpcSessionInfo {
	return {
		path: s.path,
		id: s.id,
		cwd: s.cwd,
		name: s.name,
		created: s.created.toISOString(),
		modified: s.modified.toISOString(),
		messageCount: s.messageCount,
		firstMessage: s.firstMessage,
	};
}

export function getPerformanceStatsData(session: Pick<AgentSession, "getPerformanceTracker">): {
	models: Array<{ provider: string; modelId: string; median: number; mean: number; count: number }>;
} {
	const tracker = session.getPerformanceTracker();
	return { models: tracker.getAllRollingAverages() };
}

export function getScopedModelsForRpc(session: Pick<AgentSession, "scopedModels">): RpcScopedModel[] {
	return session.scopedModels.map(({ model, thinkingLevel }) => ({
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		thinkingLevel,
	}));
}

export function getResourcesForRpc(
	session: Pick<AgentSession, "resourceLoader" | "getFilteredSkills" | "promptTemplates">,
): RpcResources {
	const extensionsResult = session.resourceLoader.getExtensions();
	return {
		contextFiles: session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path })),
		skills: session.getFilteredSkills().map((skill) => ({ name: skill.name, description: skill.description })),
		extensions: extensionsResult.extensions.map((extension) => ({
			path: extension.path,
			name: extension.sourceInfo.source || basename(extension.path),
		})),
		promptTemplates: session.promptTemplates.map((template) => ({
			name: template.name,
			description: template.description,
		})),
		systemPromptPresent:
			session.resourceLoader.getSystemPrompt() !== undefined ||
			session.resourceLoader.getAppendSystemPrompt().length > 0,
	};
}

export function getPendingMessagesForRpc(
	session: Pick<
		AgentSession,
		"getSteeringMessages" | "getFollowUpMessages" | "getSteeringMessagePayloads" | "getFollowUpMessagePayloads"
	>,
): RpcPendingMessages {
	return {
		steering: [...session.getSteeringMessages()],
		followUp: [...session.getFollowUpMessages()],
		steeringMessages: session.getSteeringMessagePayloads().map((message) => ({
			text: message.text,
			images: message.images ? [...message.images] : undefined,
		})),
		followUpMessages: session.getFollowUpMessagePayloads().map((message) => ({
			text: message.text,
			images: message.images ? [...message.images] : undefined,
		})),
	};
}

export function getStateForRpc(session: AgentSession, modelFallbackMessage?: string): RpcSessionState {
	return {
		model: session.model,
		scopedModels: getScopedModelsForRpc(session),
		usingSubscription: session.model ? session.modelRegistry.isUsingOAuth(session.model) : false,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		contextUsage: session.getContextUsage(),
		modelFallbackMessage,
		localOnlyMode: session.settingsManager.getLocalOnlyMode(),
		localOnlyModel: session.settingsManager.getLocalOnlyModel(),
	};
}

/**
 * Handle the `delete_session` RPC command: wires the active session into the core
 * {@link SessionManager.deleteSession} guard and maps the result to a discriminated
 * union the handler serializes. Extracted (like {@link getPerformanceStatsData}) so the guard
 * wiring is unit-testable without a live RPC session. Note: the authoritative active-session
 * guard lives in core — this passes the active path through; it does not re-implement it.
 * Uses the same unrestricted path-based addressing as `switch_session` (no containment guard —
 * see PR #315 discussion).
 */
export async function deleteSessionForRpc(
	sessionManager: Pick<SessionManager, "getSessionFile">,
	sessionPath: string,
): Promise<{ ok: true; method: "trash" | "unlink" } | { ok: false; error: string }> {
	const activePath = sessionManager.getSessionFile();
	const result = await SessionManager.deleteSession(sessionPath, {
		activeSessionPath: activePath,
	});
	if (!result.ok) {
		return { ok: false, error: result.error ?? "Unknown deletion error" };
	}
	return { ok: true, method: result.method };
}

/** Handle the `list_all_sessions` RPC command: list every project's sessions as RPC DTOs. */
export async function listAllSessionsForRpc(): Promise<RpcSessionInfo[]> {
	const sessions = await SessionManager.listAll();
	return sessions.map(toRpcSessionInfo);
}

/**
 * Map a {@link BackgroundAgentInfo} registry entry to the RPC DTO, converting the
 * epoch-ms timestamp to an ISO string. Shared shape guard for `list_background_agents`.
 */
export function toRpcBackgroundAgentInfo(a: Readonly<BackgroundAgentInfo>): RpcBackgroundAgentInfo {
	return {
		agentId: a.agentId,
		agentType: a.agentType,
		taskSummary: a.taskSummary,
		startedAt: new Date(a.startedAt).toISOString(),
		status: a.status,
		sessionDir: a.sessionDir,
		sessionFile: a.sessionFile,
		cwd: a.cwd,
	};
}

/** Discover available subagent types for RPC clients, sorted by display name. */
export function listAgentTypesForRpc(cwd: string): RpcAgentTypeInfo[] {
	return [...discoverAgentTypes(cwd).values()]
		.map(({ name, description }) => ({ name, description }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The slice of SettingsManager the settings RPC handlers need. */
type SettingsReader = Pick<
	SettingsManager,
	| "getDefaultProvider"
	| "getDefaultModel"
	| "getDefaultThinkingLevel"
	| "getSteeringMode"
	| "getFollowUpMode"
	| "getCompactionEnabled"
	| "getRetryEnabled"
	| "getImageAutoResize"
	| "getBlockImages"
	| "getEnableSkillCommands"
	| "getAutoLoadNestedContext"
	| "getTransport"
	| "getHideThinkingBlock"
	| "getAgentModels"
	| "getLocalOnlyMode"
	| "getLocalOnlyModel"
	| "getFinalFallbackToLocalModel"
>;

type SettingsWriter = SettingsReader &
	Pick<
		SettingsManager,
		| "setDefaultModelAndProvider"
		| "setDefaultThinkingLevel"
		| "setSteeringMode"
		| "setFollowUpMode"
		| "setCompactionEnabled"
		| "setRetryEnabled"
		| "setImageAutoResize"
		| "setBlockImages"
		| "setEnableSkillCommands"
		| "setAutoLoadNestedContext"
		| "setTransport"
		| "setHideThinkingBlock"
		| "setAgentModelsForAgent"
		| "removeAgentModelsForAgent"
		| "setLocalOnlyMode"
		| "setLocalOnlyModel"
		| "setFinalFallbackToLocalModel"
		| "hasProjectAgentModelOverride"
		| "hasGlobalSettingsLoadError"
		| "flush"
		| "drainErrors"
	>;

/**
 * Handle the `get_settings` RPC command: snapshot the persistent default settings.
 *
 * Reads the SettingsManager's merged (global + project) view — these are the values that
 * seed fresh runtimes, NOT the live session state (`get_state` reports that). Extracted
 * (like {@link deleteSessionForRpc}) so it is unit-testable without a live RPC session.
 */
export function getSettingsForRpc(settingsManager: SettingsReader): RpcSettingsSnapshot {
	return {
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModel: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		compactionEnabled: settingsManager.getCompactionEnabled(),
		retryEnabled: settingsManager.getRetryEnabled(),
		imageAutoResize: settingsManager.getImageAutoResize(),
		blockImages: settingsManager.getBlockImages(),
		enableSkillCommands: settingsManager.getEnableSkillCommands(),
		autoLoadNestedContext: settingsManager.getAutoLoadNestedContext(),
		transport: settingsManager.getTransport(),
		hideThinkingBlock: settingsManager.getHideThinkingBlock(),
		agentModels: settingsManager.getAgentModels(),
		localOnlyMode: settingsManager.getLocalOnlyMode(),
		localOnlyModel: settingsManager.getLocalOnlyModel(),
		finalFallbackToLocalModel: settingsManager.getFinalFallbackToLocalModel(),
	};
}

const SETTINGS_UPDATE_KEYS = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"steeringMode",
	"followUpMode",
	"compactionEnabled",
	"retryEnabled",
	"imageAutoResize",
	"blockImages",
	"enableSkillCommands",
	"autoLoadNestedContext",
	"transport",
	"hideThinkingBlock",
	"agentModels",
	"localOnlyMode",
	"localOnlyModel",
	"finalFallbackToLocalModel",
] as const;

const QUEUE_MODES = ["all", "one-at-a-time"] as const;
const TRANSPORT_SETTINGS = ["sse", "websocket", "auto"] as const satisfies readonly TransportSetting[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function validateAgentModels(value: unknown): { ok: true } | { ok: false; error: string } {
	if (!isPlainObject(value)) {
		return {
			ok: false,
			error: "Invalid agentModels: must be a plain object mapping agent names to model fallback arrays",
		};
	}
	for (const [agentName, models] of Object.entries(value)) {
		if (!Array.isArray(models)) {
			return {
				ok: false,
				error: `Invalid agentModels[${JSON.stringify(agentName)}]: expected an array of non-empty strings`,
			};
		}
		const invalidModel = models.find((model) => typeof model !== "string" || model.trim().length === 0);
		if (invalidModel !== undefined) {
			return {
				ok: false,
				error: `Invalid agentModels[${JSON.stringify(agentName)}]: expected an array of non-empty strings`,
			};
		}
	}
	return { ok: true };
}

/**
 * Simple promise-based mutex that serializes settings writes. RPC commands are dispatched
 * concurrently (`void handleInputLine(line)`) so two `set_settings` commands can overlap.
 * Without serialization, concurrent commands race on SettingsManager's shared error bucket
 * (`drainErrors()` clears the array for everyone): the first to drain takes all errors
 * (including the second's), and the second reports false success despite its write failing.
 *
 * This lock ensures only one apply+flush+drain block runs at a time — each `set_settings`
 * gets an error window isolated from other `set_settings` commands and from stale errors.
 *
 * Known limitation: the lock does NOT cover the per-runtime commands (`set_model`,
 * `set_steering_mode`, etc.), which persist through the same SettingsManager write queue
 * and record failures into the same shared error bucket. Because `flush()` awaits the
 * entire shared queue, a concurrent runtime setter's write failure can land in this
 * operation's post-flush drain window and be reported as a `set_settings` failure (loud
 * but mis-attributed — never a silent success). Per-operation error isolation in
 * SettingsManager is the proper fix and is tracked in
 * https://github.com/aebrer/dreb/issues/319.
 */
let settingsWriteQueue: Promise<unknown> = Promise.resolve();
function settingsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = settingsWriteQueue;
	const next = prev.then(fn, fn);
	settingsWriteQueue = next.catch(() => {});
	return next;
}

/**
 * Handle the `set_settings` RPC command: validate and persist default settings.
 *
 * Writes persistent defaults via SettingsManager only — never touches live session state
 * (the existing per-runtime commands do that). The whole payload is validated before
 * anything is applied: on any invalid field, nothing changes.
 *
 * Persistence is verified loudly: if the settings file failed to load at startup,
 * SettingsManager.save() silently no-ops — this handler reports that as an error instead
 * of returning success while nothing was written. Write failures surface the same way.
 *
 * The apply+flush+drain block is serialized via {@link settingsWriteLock} so that
 * concurrent `set_settings` commands (dispatched concurrently by the RPC input loop)
 * cannot race on the shared error bucket. Pre-existing stale errors (from other commands
 * like `set_model` that record write failures but never drain) are discarded before
 * applying. See the {@link settingsWriteLock} doc for the remaining attribution caveat
 * with runtime setters that write concurrently during the flush window.
 */
export async function setSettingsForRpc(
	settingsManager: SettingsWriter,
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	update: RpcSettingsUpdate | undefined,
): Promise<{ ok: true; settings: RpcSettingsSnapshot; warnings?: string[] } | { ok: false; error: string }> {
	// --- Validate everything first; apply nothing on any failure ---
	if (update === undefined || update === null || typeof update !== "object" || Array.isArray(update)) {
		return { ok: false, error: "set_settings requires a settings object" };
	}

	const unknownKeys = Object.keys(update).filter((key) => !(SETTINGS_UPDATE_KEYS as readonly string[]).includes(key));
	if (unknownKeys.length > 0) {
		return {
			ok: false,
			error: `Unknown settings key(s): ${unknownKeys.join(", ")}. Valid keys: ${SETTINGS_UPDATE_KEYS.join(", ")}`,
		};
	}

	const hasAnySetting = SETTINGS_UPDATE_KEYS.some((key) => update[key] !== undefined);
	if (!hasAnySetting) {
		return { ok: false, error: "set_settings requires at least one setting to change" };
	}

	if (update.defaultThinkingLevel !== undefined) {
		if (typeof update.defaultThinkingLevel !== "string" || !isValidThinkingLevel(update.defaultThinkingLevel)) {
			return {
				ok: false,
				error: `Invalid defaultThinkingLevel: ${JSON.stringify(update.defaultThinkingLevel)}. Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
			};
		}
	}

	for (const key of ["steeringMode", "followUpMode"] as const) {
		const value = update[key];
		if (value !== undefined && !(QUEUE_MODES as readonly string[]).includes(value as string)) {
			return {
				ok: false,
				error: `Invalid ${key}: ${JSON.stringify(value)}. Valid values: ${QUEUE_MODES.join(", ")}`,
			};
		}
	}

	for (const key of [
		"compactionEnabled",
		"retryEnabled",
		"imageAutoResize",
		"blockImages",
		"enableSkillCommands",
		"autoLoadNestedContext",
		"hideThinkingBlock",
	] as const) {
		const value = update[key];
		if (value !== undefined && typeof value !== "boolean") {
			return { ok: false, error: `Invalid ${key}: ${JSON.stringify(value)}. Must be a boolean` };
		}
	}

	if (update.transport !== undefined) {
		if (
			typeof update.transport !== "string" ||
			!(TRANSPORT_SETTINGS as readonly string[]).includes(update.transport)
		) {
			return {
				ok: false,
				error: `Invalid transport: ${JSON.stringify(update.transport)}. Valid values: ${TRANSPORT_SETTINGS.join(", ")}`,
			};
		}
	}

	if (update.agentModels !== undefined) {
		const validation = validateAgentModels(update.agentModels);
		if (!validation.ok) {
			return validation;
		}
	}

	const hasProvider = update.defaultProvider !== undefined;
	const hasModel = update.defaultModel !== undefined;
	if (hasProvider !== hasModel) {
		return {
			ok: false,
			error: "defaultProvider and defaultModel must be set together",
		};
	}
	if (hasProvider && hasModel) {
		if (typeof update.defaultProvider !== "string" || typeof update.defaultModel !== "string") {
			return { ok: false, error: "defaultProvider and defaultModel must be strings" };
		}
		const models = await modelRegistry.getAvailable();
		const match = models.find((m) => m.provider === update.defaultProvider && m.id === update.defaultModel);
		if (!match) {
			return {
				ok: false,
				error: `Model not found: ${update.defaultProvider}/${update.defaultModel}`,
			};
		}
	}

	// Serialize the apply+flush+drain block so concurrent set_settings commands
	// cannot race on the shared error bucket. See settingsWriteLock doc.
	return settingsWriteLock(async () => {
		// Discard stale errors left by other operations (set_model, set_steering_mode, etc.)
		// that record write failures into SettingsManager's shared error bucket but never
		// drain it. Without this, we'd mis-attribute their failures to this operation.
		settingsManager.drainErrors();

		// Persisting would silently no-op if the settings file failed to load — fail loudly
		// instead. Checked INSIDE the lock (after the stale-error discard) so a concurrent
		// reload() that flips the load-error state cannot slip between check and apply and
		// turn this write into a silent no-op reported as success.
		if (settingsManager.hasGlobalSettingsLoadError()) {
			return {
				ok: false as const,
				error: "Cannot write settings: the global settings file failed to load (fix or remove the corrupt settings.json first)",
			};
		}

		// --- Apply (validated) ---
		if (update.defaultProvider !== undefined && update.defaultModel !== undefined) {
			settingsManager.setDefaultModelAndProvider(update.defaultProvider, update.defaultModel);
		}
		if (update.defaultThinkingLevel !== undefined) {
			settingsManager.setDefaultThinkingLevel(update.defaultThinkingLevel);
		}
		if (update.steeringMode !== undefined) {
			settingsManager.setSteeringMode(update.steeringMode);
		}
		if (update.followUpMode !== undefined) {
			settingsManager.setFollowUpMode(update.followUpMode);
		}
		if (update.compactionEnabled !== undefined) {
			settingsManager.setCompactionEnabled(update.compactionEnabled);
		}
		if (update.retryEnabled !== undefined) {
			settingsManager.setRetryEnabled(update.retryEnabled);
		}
		if (update.imageAutoResize !== undefined) {
			settingsManager.setImageAutoResize(update.imageAutoResize);
		}
		if (update.blockImages !== undefined) {
			settingsManager.setBlockImages(update.blockImages);
		}
		if (update.enableSkillCommands !== undefined) {
			settingsManager.setEnableSkillCommands(update.enableSkillCommands);
		}
		if (update.autoLoadNestedContext !== undefined) {
			settingsManager.setAutoLoadNestedContext(update.autoLoadNestedContext);
		}
		if (update.transport !== undefined) {
			settingsManager.setTransport(update.transport);
		}
		if (update.hideThinkingBlock !== undefined) {
			settingsManager.setHideThinkingBlock(update.hideThinkingBlock);
		}
		if (update.localOnlyMode !== undefined) {
			settingsManager.setLocalOnlyMode(update.localOnlyMode);
		}
		if (update.localOnlyModel !== undefined) {
			settingsManager.setLocalOnlyModel(update.localOnlyModel);
		}
		if (update.finalFallbackToLocalModel !== undefined) {
			settingsManager.setFinalFallbackToLocalModel(update.finalFallbackToLocalModel);
		}

		const warnings: string[] = [];
		if (update.agentModels !== undefined) {
			for (const [agentName, models] of Object.entries(update.agentModels)) {
				if (settingsManager.hasProjectAgentModelOverride(agentName)) {
					warnings.push(
						`A project-level agentModels override for ${JSON.stringify(agentName)} (.dreb/settings.json) ` +
							"takes precedence — this change to global settings will have no effect. " +
							"Edit the project settings file to change it.",
					);
				}
				if (models.length > 0) {
					settingsManager.setAgentModelsForAgent(agentName, models);
				} else {
					settingsManager.removeAgentModelsForAgent(agentName);
				}
			}
		}

		// Ensure durability and surface write errors instead of losing them.
		await settingsManager.flush();
		const writeErrors = settingsManager.drainErrors();
		if (writeErrors.length > 0) {
			const detail = writeErrors.map((e) => `${e.scope}: ${e.error.message}`).join("; ");
			return { ok: false as const, error: `Failed to persist settings: ${detail}` };
		}

		return warnings.length > 0
			? { ok: true as const, settings: getSettingsForRpc(settingsManager), warnings }
			: { ok: true as const, settings: getSettingsForRpc(settingsManager) };
	});
}

function normalizePreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	let text = "";
	for (const part of content) {
		if (
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
		) {
			text += part.text;
		}
	}
	return text;
}

function getRpcEntryPreview(node: SessionTreeNode): string {
	const entry = node.entry;

	switch (entry.type) {
		case "message": {
			const msg = entry.message as {
				role: string;
				content?: unknown;
				stopReason?: string;
				errorMessage?: string;
				toolName?: string;
				command?: string;
			};
			const role = msg.role;
			if (role === "user") {
				return normalizePreview(extractTextContent(msg.content));
			}
			if (role === "assistant") {
				const textContent = normalizePreview(extractTextContent(msg.content));
				if (textContent) return textContent;
				if (msg.stopReason === "aborted") return "(aborted)";
				if (msg.errorMessage) return normalizePreview(msg.errorMessage);
				return "(no content)";
			}
			if (role === "toolResult") {
				return normalizePreview(`[${msg.toolName ?? "tool"}]`);
			}
			if (role === "bashExecution") {
				return normalizePreview(`[bash]: ${msg.command ?? ""}`);
			}
			return normalizePreview(`[${role}]`);
		}
		case "custom_message":
			return normalizePreview(`[${entry.customType}]: ${extractTextContent(entry.content)}`);
		case "compaction":
			return normalizePreview(`[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]`);
		case "branch_summary":
			return normalizePreview(`[branch summary]: ${entry.summary}`);
		case "model_change":
			return normalizePreview(`[model: ${entry.modelId}]`);
		case "thinking_level_change":
			return normalizePreview(`[thinking: ${entry.thinkingLevel}]`);
		case "custom":
			return normalizePreview(`[custom: ${entry.customType}]`);
		case "label":
			return normalizePreview(`[label: ${entry.label ?? "(cleared)"}]`);
		case "session_info":
			return normalizePreview(`[title: ${entry.name || "empty"}]`);
		default: {
			// Compile-time exhaustiveness guard: a new SessionEntry type forces an update here.
			const _exhaustive: never = entry;
			// Runtime: unknown types from forward-compat/corrupt session files get a placeholder.
			return normalizePreview(`[${(entry as { type: string }).type}]`);
		}
	}
}

function toRpcTreeNode(node: SessionTreeNode): RpcTreeNode {
	const role = node.entry.type === "message" ? String(node.entry.message.role) : undefined;
	return {
		id: node.entry.id,
		parentId: node.entry.parentId,
		type: node.entry.type,
		...(role !== undefined ? { role } : {}),
		preview: getRpcEntryPreview(node),
		timestamp: node.entry.timestamp,
		...(node.label !== undefined ? { label: node.label } : {}),
		children: [],
	};
}

/**
 * Map core session tree nodes to stable RPC DTOs without leaking raw entries/messages.
 * Uses an explicit stack so deep linear session trees do not overflow the JS call stack.
 */
export function toRpcTreeNodes(nodes: SessionTreeNode[]): RpcTreeNode[] {
	const roots: RpcTreeNode[] = [];
	const stack: Array<{ source: SessionTreeNode; targetSiblings: RpcTreeNode[] }> = [];

	for (let i = nodes.length - 1; i >= 0; i--) {
		stack.push({ source: nodes[i]!, targetSiblings: roots });
	}

	while (stack.length > 0) {
		const { source, targetSiblings } = stack.pop()!;
		const dto = toRpcTreeNode(source);
		targetSiblings.push(dto);

		for (let i = source.children.length - 1; i >= 0; i--) {
			stack.push({ source: source.children[i]!, targetSiblings: dto.children });
		}
	}

	return roots;
}

/** Return the current session tree and active leaf as RPC DTOs. */
export function getTreeForRpc(sessionManager: Pick<SessionManager, "getTree" | "getLeafId">): {
	roots: RpcTreeNode[];
	leafId: string | null;
} {
	return { roots: toRpcTreeNodes(sessionManager.getTree()), leafId: sessionManager.getLeafId() };
}

/** Navigate the active session tree, returning only the stable RPC result fields. */
export async function navigateTreeForRpc(
	session: Pick<AgentSession, "navigateTree">,
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
): Promise<{ cancelled: boolean; editorText?: string }> {
	const result = await session.navigateTree(targetId, options ?? {});
	return {
		cancelled: result.cancelled,
		...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
	};
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession, modelFallbackMessage?: string): Promise<never> {
	takeOverStdout();

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	if (session.sessionFile && session.messages.length > 0) {
		const rehydratedCount = rehydrateBackgroundAgentsFromDisk(session.sessionFile);
		if (rehydratedCount > 0) {
			console.error(
				`[rpc] Rehydrated ${rehydratedCount} background subagent${rehydratedCount === 1 ? "" : "s"} from disk`,
			);
		}
	}

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let dailyCostTracker: DailyCostTracker | undefined;
	let dailyCostTrackerPrimed = false;

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// Set up extensions with RPC-based UI context
	await session.bindExtensions({
		uiContext: createExtensionUIContext(),
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				// Delegate to AgentSession (handles setup + agent state sync)
				const success = await session.newSession(options);
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onError: (err) => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
	});

	const getDailyCost = async (): Promise<number> => {
		dailyCostTracker ??= new DailyCostTracker();
		if (!dailyCostTrackerPrimed) {
			await dailyCostTracker.refresh();
			dailyCostTrackerPrimed = true;
		}
		return dailyCostTracker.getDailyCost();
	};

	const cwd = session.sessionManager.getCwd();
	const tabTitleSettings = session.settingsManager.getTabTitleSettings();
	const tabTitleGenerator =
		!session.sessionName && tabTitleSettings?.enabled !== false
			? new TabTitleGenerator(tabTitleSettings, {
					setTitle: () => {},
					setSessionName: (name) => {
						if (!session.sessionName) {
							session.setSessionName(name);
						}
					},
					getSessionName: () => session.sessionName,
					getMessages: () => session.messages,
					getModel: () => session.model,
					getModelRegistry: () => session.modelRegistry,
					getProvider: () => session.model?.provider,
					getAgentModelsOverride: (name) => session.settingsManager.getAgentModelsForAgent(name),
					getBranch: () => getGitBranch(cwd),
					getRepo: () => basename(cwd),
					getCwd: () => cwd,
					onError: (err) => {
						console.error(
							`[rpc] Tab title auto-generation failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					},
				})
			: undefined;

	// Output all agent events as JSON
	session.subscribe((event) => {
		if (tabTitleGenerator && !session.sessionName) {
			if (event.type === "tool_execution_end") {
				tabTitleGenerator.onToolEnd({
					toolName: event.toolName,
					isError: event.isError,
					result: event.result,
				});
			} else if (event.type === "message_end") {
				tabTitleGenerator.onMessageEnd(event.message);
			}
		}
		output(event);
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
					})
					.catch((e) => output(error(id, "prompt", e.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				const { abortBackgroundAgents } = await import("../../core/tools/subagent.js");
				abortBackgroundAgents();
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, "new_session", { cancelled });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				return success(id, "get_state", getStateForRpc(session, modelFallbackMessage));
			}

			case "get_resources": {
				return success(id, "get_resources", getResourcesForRpc(session));
			}

			case "get_git_branch": {
				return success(id, "get_git_branch", { branch: getGitBranch(session.sessionManager.getCwd()) });
			}

			case "get_daily_cost": {
				return success(id, "get_daily_cost", { cost: await getDailyCost() });
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "resolve_model": {
				session.modelRegistry.refresh();
				const models = await session.modelRegistry.getAvailable();
				const result = parseModelPattern(command.pattern, models);
				if (!result.model) {
					return success(id, "resolve_model", null);
				}
				return success(id, "resolve_model", {
					model: result.model,
					warning: result.warning,
				});
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				session.modelRegistry.refresh();
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			case "buddy_hatch": {
				const model = session.model;
				if (!model) {
					return error(id, "buddy_hatch", "No model available. Set a model first.");
				}
				const apiKey = await session.modelRegistry.getApiKey(model);
				if (!apiKey) {
					return error(id, "buddy_hatch", "No API key available for the current model.");
				}
				const { BuddyManager } = await import("../../core/buddy/buddy-manager.js");
				const manager = new BuddyManager();
				const state = await manager.hatch(model, apiKey);
				return success(id, "buddy_hatch", { state });
			}

			case "buddy_reroll": {
				const model = session.model;
				if (!model) {
					return error(id, "buddy_reroll", "No model available. Set a model first.");
				}
				const apiKey = await session.modelRegistry.getApiKey(model);
				if (!apiKey) {
					return error(id, "buddy_reroll", "No API key available for the current model.");
				}
				const { BuddyManager } = await import("../../core/buddy/buddy-manager.js");
				const manager = new BuddyManager();
				if (!manager.hasStoredBuddy()) {
					return error(id, "buddy_reroll", "No buddy to reroll. Use hatch first.");
				}
				const state = await manager.reroll(model, apiKey);
				return success(id, "buddy_reroll", { state });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "get_pending_messages": {
				return success(id, "get_pending_messages", getPendingMessagesForRpc(session));
			}

			case "clear_pending_messages": {
				return success(id, "clear_pending_messages", session.clearQueue());
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			case "abort_compaction": {
				session.abortCompaction();
				return success(id, "abort_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "get_performance_stats": {
				return success(id, "get_performance_stats", getPerformanceStatsData(session));
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, "switch_session", { cancelled });
			}

			case "delete_session": {
				const result = await deleteSessionForRpc(session.sessionManager, command.sessionPath);
				if (!result.ok) {
					return error(id, "delete_session", result.error);
				}
				return success(id, "delete_session", { method: result.method });
			}

			case "fork": {
				const result = await session.fork(command.entryId);
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_tree": {
				return success(id, "get_tree", getTreeForRpc(session.sessionManager));
			}

			case "navigate_tree": {
				try {
					const result = await navigateTreeForRpc(session, command.targetId, {
						summarize: command.summarize,
						customInstructions: command.customInstructions,
						replaceInstructions: command.replaceInstructions,
						label: command.label,
					});
					return success(id, "navigate_tree", result);
				} catch (e) {
					return error(id, "navigate_tree", e instanceof Error ? e.message : String(e));
				}
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			// =================================================================
			// Session Listing
			// =================================================================

			case "list_sessions": {
				const cwd = session.sessionManager.getCwd();
				const sessionDir = session.sessionManager.getSessionDir();
				const sessions = await SessionManager.list(cwd, sessionDir);
				return success(id, "list_sessions", { sessions: sessions.map(toRpcSessionInfo) });
			}

			case "list_all_sessions": {
				return success(id, "list_all_sessions", { sessions: await listAllSessionsForRpc() });
			}

			// =================================================================
			// Background agents
			// =================================================================

			case "list_background_agents": {
				return success(id, "list_background_agents", {
					agents: getBackgroundAgents().map(toRpcBackgroundAgentInfo),
				});
			}

			case "list_agent_types": {
				return success(id, "list_agent_types", {
					agentTypes: listAgentTypesForRpc(session.sessionManager.getCwd()),
				});
			}

			// =================================================================
			// Settings (persistent defaults)
			// =================================================================

			case "get_settings": {
				return success(id, "get_settings", getSettingsForRpc(session.settingsManager));
			}

			case "set_settings": {
				const result = await setSettingsForRpc(session.settingsManager, session.modelRegistry, command.settings);
				if (!result.ok) {
					return error(id, "set_settings", result.error);
				}
				return success(
					id,
					"set_settings",
					result.warnings && result.warnings.length > 0
						? { ...result.settings, warnings: result.warnings }
						: result.settings,
				);
			}

			// =================================================================
			// Version
			// =================================================================

			case "get_version": {
				return success(id, "get_version", { version: VERSION });
			}

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.getFilteredSkills()) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				const unknownCommand = command as { type: string; id?: string };
				return error(unknownCommand.id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(): Promise<never> {
		const currentRunner = session.extensionRunner;
		if (currentRunner?.hasHandlers("session_shutdown")) {
			await currentRunner.emit({ type: "session_shutdown" });
		}

		dailyCostTracker?.dispose();
		detachInput();
		process.stdin.pause();
		process.exit(0);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch (e: any) {
			output(error(undefined, "parse", `Failed to parse JSON: ${e.message}`));
			return;
		}

		try {
			// Handle extension UI responses
			if (parsed.type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: any) {
			const id = parsed?.id;
			const cmd = parsed?.type || "unknown";
			output(error(id, cmd, `Command failed: ${e.message}`));
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);
	process.stdin.on("error", () => {
		void shutdown();
	});

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
