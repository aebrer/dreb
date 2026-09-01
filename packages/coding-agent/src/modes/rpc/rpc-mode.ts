/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: RpcEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { basename } from "node:path";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../../cli/args.js";
import { VERSION } from "../../config.js";
import type { AgentSession } from "../../core/agent-session.js";
import {
	canonicalizeTrustedRoots,
	matchContextTrust,
	validateTrustedContextFolder,
	validateTrustedContextFolders,
} from "../../core/context-trust.js";
import { DailyCostTracker } from "../../core/daily-cost-tracker.js";
import {
	acquireDreamLock,
	buildDreamPrompt,
	cleanupDreamTmpDirs,
	parseDreamCommand,
	performDreamBackup,
	pruneOldBackups,
	resolveDreamContext,
	validateArchivePath,
	validateMemoryLinks,
} from "../../core/dream.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { getGitBranch } from "../../core/git-branch.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import { parseModelPattern, resolveModelScopePatterns } from "../../core/model-resolver.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import type { SessionInfo, SessionTreeNode } from "../../core/session-manager.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager, TransportSetting } from "../../core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS, parseBuiltinSlashCommand } from "../../core/slash-commands.js";
import { TabTitleGenerator } from "../../core/tab-title.js";
import { validateThinkingLevelForModel } from "../../core/thinking.js";
import { resolveToCwd } from "../../core/tools/path-utils.js";
import {
	type BackgroundAgentInfo,
	discoverAgentTypes,
	getBackgroundAgentPendingSteering,
	getBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
	steerBackgroundAgent,
} from "../../core/tools/subagent.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { createDashboardRpcEventProjector } from "./rpc-event-projection.js";
import type {
	RpcAgentTypeInfo,
	RpcBackgroundAgentInfo,
	RpcBlockingExtensionUIRequest,
	RpcCommand,
	RpcContextTrustEvaluation,
	RpcContextTrustMutationResult,
	RpcDashboardSnapshot,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPendingMessages,
	RpcPerformanceStats,
	RpcResources,
	RpcResponse,
	RpcScopedModel,
	RpcSessionInfo,
	RpcSessionState,
	RpcSettingsSnapshot,
	RpcSettingsUpdate,
	RpcSlashCommand,
	RpcTreeNode,
	RpcTrustedFolderRemovalResult,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcDashboardSnapshot,
	RpcDashboardSnapshotBarrierEvent,
	RpcEvent,
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

export function getPerformanceStatsData(session: Pick<AgentSession, "getPerformanceTracker">): RpcPerformanceStats {
	const tracker = session.getPerformanceTracker();
	return { models: tracker.getAllModelSummaries() };
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

export function getCommandsForRpc(
	session: Pick<AgentSession, "extensionRunner" | "promptTemplates" | "getFilteredSkills">,
): RpcSlashCommand[] {
	const commands = new Map<string, RpcSlashCommand>();
	for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
		commands.set(command.invocationName, {
			name: command.invocationName,
			description: command.description,
			source: "extension",
			sourceInfo: command.sourceInfo,
		});
	}
	for (const template of session.promptTemplates) {
		if (!commands.has(template.name)) {
			commands.set(template.name, {
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			});
		}
	}
	for (const skill of session.getFilteredSkills()) {
		const name = `skill:${skill.name}`;
		if (!commands.has(name)) {
			commands.set(name, { name, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
		}
	}
	// Built-ins deliberately win collisions, matching interactive autocomplete and
	// ensuring a colliding resource can never make built-in text reach the model.
	for (const command of BUILTIN_SLASH_COMMANDS) {
		commands.set(command.name, {
			name: command.name,
			description: command.description,
			source: "builtin",
			dashboard: command.dashboard !== false,
		});
	}
	return [...commands.values()];
}

export function getBuiltinPromptRejection(message: string): string | undefined {
	const parsed = parseBuiltinSlashCommand(message);
	return parsed
		? `Built-in slash command /${parsed.command.name} must be handled by the RPC client; it was not sent to the model.`
		: undefined;
}

async function runDreamForRpc(session: AgentSession, args = ""): Promise<{ message: string }> {
	const command = parseDreamCommand(`/dream${args ? ` ${args}` : ""}`);
	if (command.type === "showBackup") {
		return { message: `Dream backup path: ${session.settingsManager.getDreamArchivePath()}` };
	}
	if (command.type === "setBackup") {
		const absolutePath = resolveToCwd(command.path, session.sessionManager.getCwd());
		const context = await resolveDreamContext(session.settingsManager);
		validateArchivePath(absolutePath, [
			context.globalMemoryDir,
			...context.projectMemoryDirs,
			...context.claudeMemoryDirs,
		]);
		if (session.settingsManager.hasGlobalSettingsLoadError()) {
			throw new Error("Cannot write dream backup path: the global settings file failed to load");
		}
		session.settingsManager.drainErrors();
		session.settingsManager.setDreamArchivePath(absolutePath);
		try {
			await session.settingsManager.flush();
		} catch (error) {
			session.settingsManager.reload();
			throw error;
		}
		const writeErrors = session.settingsManager.drainErrors();
		if (writeErrors.length > 0) {
			session.settingsManager.reload();
			throw new Error(
				`Failed to persist dream backup path: ${writeErrors.map((entry) => `${entry.scope}: ${entry.error.message}`).join("; ")}`,
			);
		}
		return { message: `Dream backup path set to: ${absolutePath}` };
	}

	let releaseLock: (() => void) | undefined;
	let context: Awaited<ReturnType<typeof resolveDreamContext>> | undefined;
	try {
		releaseLock = await acquireDreamLock();
		context = await resolveDreamContext(session.settingsManager);
		validateArchivePath(context.archivePath, [
			context.globalMemoryDir,
			...context.projectMemoryDirs,
			...context.claudeMemoryDirs,
		]);
		const backup = await performDreamBackup(context);
		if (!backup.verified) {
			throw new Error(`Backup verification failed; check ${backup.backupPath}`);
		}
		await session.prompt(buildDreamPrompt(context, backup), { source: "rpc" });
		const links = validateMemoryLinks([context.globalMemoryDir, ...context.projectMemoryDirs]);
		await pruneOldBackups(context.archivePath);
		return {
			message: links.valid
				? `Dream completed. Backup: ${backup.backupPath}`
				: `Dream completed with ${links.brokenLinks.length} broken memory link(s). Backup: ${backup.backupPath}`,
		};
	} finally {
		releaseLock?.();
		if (context) cleanupDreamTmpDirs([context.globalMemoryDir, ...context.projectMemoryDirs]);
	}
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
		tasks: session.tasks.map((task) => ({ ...task })),
		usingSubscription: session.model ? session.modelRegistry.isUsingOAuth(session.model) : false,
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isRetrying: session.isRetrying,
		retryAttempt: session.retryAttempt,
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
	};
}

/**
 * Dashboard transcript snapshots use persisted branch context whenever the
 * runtime is not streaming so failed attempts removed from the next provider
 * request remain visible during retry backoff and after recovery. The snapshot
 * state carries retry activity separately, preventing those historical errors
 * from being mistaken for terminal failures.
 */
export function getDashboardMessagesForRpc(session: AgentSession) {
	return [...(session.isStreaming ? session.messages : session.sessionManager.buildSessionContext().messages)];
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
		arbitrations: a.arbitrations?.map((record) => structuredClone(record)),
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
	| "getContinueAfterAutoCompaction"
	| "getRetryEnabled"
	| "getMaxConcurrentSubagents"
	| "getImageAutoResize"
	| "getBlockImages"
	| "getEnableSkillCommands"
	| "getGlobalContextTrustPolicy"
	| "getConfiguredTrustedContextFolders"
	| "getTransport"
	| "getHideThinkingBlock"
	| "getAgentModels"
	| "getGlobalSubagentArbiterSettings"
	| "getTabTitleSettings"
	| "getEnabledModels"
	| "hasProjectEnabledModelsOverride"
>;

type SettingsRefresher = SettingsReader &
	Pick<
		SettingsManager,
		"reload" | "flush" | "drainErrors" | "hasGlobalSettingsLoadError" | "hasProjectSettingsLoadError"
	>;

type SettingsWriter = SettingsRefresher &
	Pick<
		SettingsManager,
		| "setDefaultModelAndProvider"
		| "setDefaultThinkingLevel"
		| "setSteeringMode"
		| "setFollowUpMode"
		| "setCompactionEnabled"
		| "setContinueAfterAutoCompaction"
		| "setRetryEnabled"
		| "setMaxConcurrentSubagents"
		| "setImageAutoResize"
		| "setBlockImages"
		| "setEnableSkillCommands"
		| "setAutoLoadNestedContext"
		| "setTrustedContextFolders"
		| "removeTrustedContextFolder"
		| "setContextTrust"
		| "setTransport"
		| "setHideThinkingBlock"
		| "setAgentModelsForAgent"
		| "removeAgentModelsForAgent"
		| "hasProjectAgentModelOverride"
		| "setGlobalSubagentArbiterSettings"
		| "setGlobalTabTitleSettings"
		| "setEnabledModels"
	>;

/**
 * Handle the `get_settings` RPC command: snapshot the persistent default settings.
 *
 * Most fields read the SettingsManager's merged (global + project) view. Context trust
 * fields intentionally read global settings only, so projects cannot expand the policy.
 * These seed fresh runtimes, NOT the live session state (`get_state` reports that). Extracted
 * (like {@link deleteSessionForRpc}) so it is unit-testable without a live RPC session.
 */
export function getSettingsForRpc(
	settingsManager: SettingsReader,
	availableModels: Awaited<ReturnType<ModelRegistry["getAvailable"]>> = [],
): RpcSettingsSnapshot {
	const contextTrust = settingsManager.getGlobalContextTrustPolicy();
	const configuredTrustedFolders = settingsManager.getConfiguredTrustedContextFolders();
	const enabledModels = settingsManager.getEnabledModels();
	const hasProjectEnabledModelsOverride = settingsManager.hasProjectEnabledModelsOverride();
	const scopeResolution = resolveModelScopePatterns(enabledModels ?? [], availableModels);
	return {
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModel: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		compactionEnabled: settingsManager.getCompactionEnabled(),
		continueAfterAutoCompaction: settingsManager.getContinueAfterAutoCompaction(),
		retryEnabled: settingsManager.getRetryEnabled(),
		maxConcurrentSubagents: settingsManager.getMaxConcurrentSubagents(),
		imageAutoResize: settingsManager.getImageAutoResize(),
		blockImages: settingsManager.getBlockImages(),
		enableSkillCommands: settingsManager.getEnableSkillCommands(),
		autoLoadNestedContext: contextTrust.unrestricted,
		trustedContextFolders: configuredTrustedFolders,
		effectiveTrustedContextRoots: canonicalizeTrustedRoots(contextTrust.trustedFolders),
		transport: settingsManager.getTransport(),
		hideThinkingBlock: settingsManager.getHideThinkingBlock(),
		agentModels: settingsManager.getAgentModels(),
		subagentArbiter: settingsManager.getGlobalSubagentArbiterSettings(),
		tabTitle: settingsManager.getTabTitleSettings(),
		enabledModels,
		resolvedScopedModels: scopeResolution.models.map(({ model, thinkingLevel }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		})),
		scopeWarnings: scopeResolution.warnings,
		hasProjectEnabledModelsOverride,
		enabledModelsSource: hasProjectEnabledModelsOverride
			? "project"
			: enabledModels === undefined
				? "default"
				: "global",
	};
}

async function buildSettingsSnapshotForRpc(
	settingsManager: SettingsReader,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<RpcSettingsSnapshot> {
	return getSettingsForRpc(settingsManager, modelRegistry ? await modelRegistry.getAvailable() : []);
}

function formatSettingsErrors(errors: Array<{ scope: string; error: Error }>): string {
	return errors.map((entry) => `${entry.scope}: ${entry.error.message}`).join("; ");
}

/**
 * Reload durable global and project settings before serving `get_settings`.
 *
 * The shared settings-operation lock prevents a refresh from discarding another RPC
 * settings operation's queued modifications. A failed queued write is returned before
 * reload so its in-memory changes remain intact rather than being replaced by stale disk
 * content. Reload failures leave SettingsManager's previous values in memory, therefore
 * they must be surfaced as an RPC error instead of producing a stale snapshot.
 */
export async function getFreshSettingsForRpc(
	settingsManager: SettingsRefresher,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<{ ok: true; settings: RpcSettingsSnapshot } | { ok: false; error: string }> {
	return settingsWriteLock(async () => {
		try {
			// A runtime setter may have enqueued a write outside the RPC settings lock.
			// Waiting for SettingsManager's own queue protects that update from reload().
			await settingsManager.flush();
		} catch (error) {
			return { ok: false as const, error: `Failed to refresh settings: ${(error as Error).message}` };
		}

		const writeErrors = settingsManager.drainErrors();
		if (writeErrors.length > 0) {
			return {
				ok: false as const,
				error: `Failed to refresh settings: pending settings write failed: ${formatSettingsErrors(writeErrors)}`,
			};
		}

		try {
			settingsManager.reload();
		} catch (error) {
			return { ok: false as const, error: `Failed to reload settings: ${(error as Error).message}` };
		}

		const loadErrors = settingsManager.drainErrors();
		if (
			loadErrors.length > 0 ||
			settingsManager.hasGlobalSettingsLoadError() ||
			settingsManager.hasProjectSettingsLoadError()
		) {
			const detail = formatSettingsErrors(loadErrors);
			return {
				ok: false as const,
				error: detail ? `Failed to reload settings: ${detail}` : "Failed to reload settings from durable storage",
			};
		}

		try {
			const availableModels = modelRegistry ? await modelRegistry.getAvailable() : [];
			return { ok: true as const, settings: getSettingsForRpc(settingsManager, availableModels) };
		} catch (error) {
			return { ok: false as const, error: `Failed to load available models: ${(error as Error).message}` };
		}
	});
}

const SETTINGS_UPDATE_KEYS = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"steeringMode",
	"followUpMode",
	"compactionEnabled",
	"continueAfterAutoCompaction",
	"retryEnabled",
	"maxConcurrentSubagents",
	"imageAutoResize",
	"blockImages",
	"enableSkillCommands",
	"autoLoadNestedContext",
	"trustedContextFolders",
	"transport",
	"hideThinkingBlock",
	"agentModels",
	"enabledModels",
	"subagentArbiter",
	"tabTitle",
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

/** Evaluate a strictly canonical, absolute directory through the core trust matcher. */
export function evaluateContextTrustForRpc(
	settingsManager: Pick<SettingsManager, "getGlobalContextTrustPolicy">,
	path: unknown,
): { ok: true; evaluation: RpcContextTrustEvaluation } | { ok: false; error: string } {
	let canonicalTarget: string;
	try {
		canonicalTarget = validateTrustedContextFolder(path);
	} catch (error) {
		return { ok: false, error: `Invalid context trust path: ${(error as Error).message}` };
	}

	const policy = settingsManager.getGlobalContextTrustPolicy();
	const match = matchContextTrust(policy, canonicalTarget);
	if (!match) {
		return { ok: true, evaluation: { canonicalTarget, state: "untrusted" } };
	}
	if (policy.unrestricted) {
		return { ok: true, evaluation: { canonicalTarget, state: "unrestricted" } };
	}
	return {
		ok: true,
		evaluation: { canonicalTarget, state: "trusted-root", grantingRoot: match.trustedRoot },
	};
}

/**
 * Simple promise-based mutex that serializes durable settings operations. RPC commands are
 * dispatched concurrently (`void handleInputLine(line)`) so settings writes and refreshes
 * can overlap. Without serialization, a refresh could reload over queued modifications, and
 * concurrent operations could race on SettingsManager's shared error bucket (`drainErrors()`
 * clears the array for everyone).
 *
 * This lock ensures only one apply/flush/drain or flush/reload/drain block runs at a time.
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

async function persistContextTrustMutationForRpc(
	settingsManager: SettingsWriter,
	folders: string[],
	targetPath: string,
	mutation: Pick<RpcContextTrustMutationResult, "addedRoot" | "removedRoot">,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<{ ok: true; result: RpcContextTrustMutationResult } | { ok: false; error: string }> {
	settingsManager.drainErrors();
	if (settingsManager.hasGlobalSettingsLoadError()) {
		return {
			ok: false as const,
			error: "Cannot write settings: the global settings file failed to load (fix or remove the corrupt settings.json first)",
		};
	}

	try {
		settingsManager.setTrustedContextFolders(folders);
		await settingsManager.flush();
	} catch (error) {
		// A security-policy mutation must not remain effective solely in memory when its
		// durable write fails. Reload restores the last persisted global policy.
		settingsManager.reload();
		return { ok: false as const, error: `Failed to persist settings: ${(error as Error).message}` };
	}
	const writeErrors = settingsManager.drainErrors();
	if (writeErrors.length > 0) {
		const detail = writeErrors.map((e) => `${e.scope}: ${e.error.message}`).join("; ");
		// SettingsManager records queued write failures rather than rejecting flush(). Its
		// in-memory policy has already changed, so restore it from durable storage before
		// reporting failure rather than leaving an undurable trusted root effective.
		settingsManager.reload();
		return { ok: false as const, error: `Failed to persist settings: ${detail}` };
	}

	const evaluated = evaluateContextTrustForRpc(settingsManager, targetPath);
	if (!evaluated.ok) return evaluated;
	return {
		ok: true as const,
		result: {
			evaluation: evaluated.evaluation,
			settings: await buildSettingsSnapshotForRpc(settingsManager, modelRegistry),
			...mutation,
		},
	};
}

/** Add a canonical directory to the global trusted roots and flush the change. */
export async function trustContextFolderForRpc(
	settingsManager: SettingsWriter,
	path: unknown,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<{ ok: true; result: RpcContextTrustMutationResult } | { ok: false; error: string }> {
	return settingsWriteLock(async () => {
		const evaluated = evaluateContextTrustForRpc(settingsManager, path);
		if (!evaluated.ok) return evaluated;

		// Existing malformed entries are fail-closed. A trust mutation rewrites the configured
		// list as the canonical configured roots plus this new canonical root.
		const roots = canonicalizeTrustedRoots(settingsManager.getConfiguredTrustedContextFolders());
		let folders: string[];
		try {
			folders = validateTrustedContextFolders([...roots, evaluated.evaluation.canonicalTarget]);
		} catch (error) {
			return { ok: false as const, error: (error as Error).message };
		}
		return persistContextTrustMutationForRpc(
			settingsManager,
			folders,
			evaluated.evaluation.canonicalTarget,
			{
				...(folders.includes(evaluated.evaluation.canonicalTarget)
					? { addedRoot: evaluated.evaluation.canonicalTarget }
					: {}),
			},
			modelRegistry,
		);
	});
}

/** Remove the root actually granting a directory access, rather than the supplied descendant. */
export async function untrustContextFolderForRpc(
	settingsManager: SettingsWriter,
	path: unknown,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<{ ok: true; result: RpcContextTrustMutationResult } | { ok: false; error: string }> {
	return settingsWriteLock(async () => {
		const evaluated = evaluateContextTrustForRpc(settingsManager, path);
		if (!evaluated.ok) return evaluated;
		if (evaluated.evaluation.state === "unrestricted") {
			return {
				ok: false,
				error: "Cannot untrust a context folder while unrestricted nested context loading is enabled; disable autoLoadNestedContext first",
			};
		}
		if (evaluated.evaluation.state === "untrusted") {
			return {
				ok: true,
				result: {
					evaluation: evaluated.evaluation,
					settings: await buildSettingsSnapshotForRpc(settingsManager, modelRegistry),
				},
			};
		}

		const removedRoot = evaluated.evaluation.grantingRoot!;
		const roots = canonicalizeTrustedRoots(settingsManager.getConfiguredTrustedContextFolders());
		return persistContextTrustMutationForRpc(
			settingsManager,
			roots.filter((root) => root !== removedRoot),
			evaluated.evaluation.canonicalTarget,
			{ removedRoot },
			modelRegistry,
		);
	});
}

/** Remove a configured trusted-folder string exactly as stored and flush the change. */
export async function removeTrustedContextFolderForRpc(
	settingsManager: SettingsWriter,
	path: unknown,
	modelRegistry?: Pick<ModelRegistry, "getAvailable">,
): Promise<{ ok: true; result: RpcTrustedFolderRemovalResult } | { ok: false; error: string }> {
	return settingsWriteLock(async () => {
		if (typeof path !== "string" || path.length === 0) {
			return { ok: false as const, error: "remove_trusted_context_folder requires a non-empty string path" };
		}

		settingsManager.drainErrors();
		if (settingsManager.hasGlobalSettingsLoadError()) {
			return {
				ok: false as const,
				error: "Cannot write settings: the global settings file failed to load (fix or remove the corrupt settings.json first)",
			};
		}

		try {
			settingsManager.removeTrustedContextFolder(path);
			await settingsManager.flush();
		} catch (error) {
			// A security-policy mutation must not remain effective solely in memory when its
			// durable write fails. Reload restores the last persisted global policy.
			settingsManager.reload();
			return { ok: false as const, error: `Failed to persist settings: ${(error as Error).message}` };
		}
		const writeErrors = settingsManager.drainErrors();
		if (writeErrors.length > 0) {
			const detail = writeErrors.map((e) => `${e.scope}: ${e.error.message}`).join("; ");
			// SettingsManager records queued write failures rather than rejecting flush(). Its
			// in-memory policy has already changed, so restore it from durable storage before
			// reporting failure rather than leaving an undurable trust removal effective.
			settingsManager.reload();
			return { ok: false as const, error: `Failed to persist settings: ${detail}` };
		}

		return {
			ok: true as const,
			result: {
				settings: await buildSettingsSnapshotForRpc(settingsManager, modelRegistry),
				removedFolder: path,
			},
		};
	});
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
		"continueAfterAutoCompaction",
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

	if (
		update.maxConcurrentSubagents !== undefined &&
		(!Number.isSafeInteger(update.maxConcurrentSubagents) || update.maxConcurrentSubagents < 0)
	) {
		return {
			ok: false,
			error: `Invalid maxConcurrentSubagents: ${JSON.stringify(update.maxConcurrentSubagents)}. Must be a non-negative whole number`,
		};
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

	let canonicalEnabledModels: string[] | undefined;
	if (update.enabledModels !== undefined && update.enabledModels !== null) {
		if (!Array.isArray(update.enabledModels)) {
			return {
				ok: false,
				error: "Invalid enabledModels: must be a non-empty array of exact model references or null",
			};
		}
		if (update.enabledModels.length === 0) {
			return {
				ok: false,
				error: "Invalid enabledModels: at least one model must remain enabled; use null to enable all",
			};
		}

		const availableModels = await modelRegistry.getAvailable();
		const seen = new Set<string>();
		canonicalEnabledModels = [];
		for (const reference of update.enabledModels) {
			if (typeof reference !== "string" || reference.trim().length === 0 || reference !== reference.trim()) {
				return { ok: false, error: "Invalid enabledModels: every entry must be a non-empty exact model reference" };
			}
			const normalizedReference = reference.toLowerCase();
			const matches = availableModels.filter(
				(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
			);
			if (matches.length !== 1) {
				return {
					ok: false,
					error: `Invalid enabledModels entry ${JSON.stringify(reference)}: expected an available exact provider/model reference`,
				};
			}
			const match = matches[0]!;
			const canonical = `${match.provider}/${match.id}`;
			if (seen.has(canonical)) {
				return { ok: false, error: `Invalid enabledModels: duplicate model ${JSON.stringify(canonical)}` };
			}
			seen.add(canonical);
			canonicalEnabledModels.push(canonical);
		}

		if (
			canonicalEnabledModels.length === availableModels.length &&
			availableModels.every((model) => seen.has(`${model.provider}/${model.id}`))
		) {
			canonicalEnabledModels = undefined;
		}
	}

	let subagentArbiter = update.subagentArbiter === null ? undefined : update.subagentArbiter;
	if (subagentArbiter !== undefined) {
		if (!isPlainObject(subagentArbiter)) {
			return { ok: false, error: "subagentArbiter must be an object or null" };
		}
		const validKeys = ["enabled", "model", "thinking", "guidePath"];
		const unknownArbiterKeys = Object.keys(subagentArbiter).filter((key) => !validKeys.includes(key));
		if (unknownArbiterKeys.length > 0) {
			return { ok: false, error: `Unknown subagentArbiter key(s): ${unknownArbiterKeys.join(", ")}` };
		}
		if (subagentArbiter.enabled !== undefined && typeof subagentArbiter.enabled !== "boolean") {
			return { ok: false, error: "subagentArbiter.enabled must be a boolean" };
		}
		if (subagentArbiter.enabled === false) {
			// Explicit disablement is the recovery path for fail-closed policies.
			// Preserve retained fields without validating them so malformed manual
			// edits cannot trap users in a policy that blocks every child spawn.
			subagentArbiter = { ...subagentArbiter };
		} else {
			if (
				subagentArbiter.model !== undefined &&
				(typeof subagentArbiter.model !== "string" || !subagentArbiter.model.trim())
			) {
				return { ok: false, error: "subagentArbiter.model must be a non-empty exact provider/model string" };
			}
			if (
				subagentArbiter.thinking !== undefined &&
				(typeof subagentArbiter.thinking !== "string" || !isValidThinkingLevel(subagentArbiter.thinking))
			) {
				return {
					ok: false,
					error: `Invalid subagentArbiter.thinking: ${JSON.stringify(subagentArbiter.thinking)}. Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				};
			}
			if (
				subagentArbiter.guidePath !== undefined &&
				(typeof subagentArbiter.guidePath !== "string" || !subagentArbiter.guidePath.trim())
			) {
				return { ok: false, error: "subagentArbiter.guidePath must be a non-empty string" };
			}
			if (subagentArbiter.enabled === true && !subagentArbiter.model) {
				return { ok: false, error: "Enabling subagentArbiter requires an exact provider/model" };
			}
			if (subagentArbiter.model) {
				const slash = subagentArbiter.model.indexOf("/");
				if (slash <= 0 || slash === subagentArbiter.model.length - 1 || /\s/.test(subagentArbiter.model)) {
					return { ok: false, error: "subagentArbiter.model must be an exact provider/model" };
				}
				const provider = subagentArbiter.model.slice(0, slash);
				const modelId = subagentArbiter.model.slice(slash + 1);
				const models = await modelRegistry.getAvailable();
				const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
				if (!model) return { ok: false, error: `Arbiter model not found: ${subagentArbiter.model}` };
				if (subagentArbiter.thinking !== undefined) {
					const validation = validateThinkingLevelForModel(model, subagentArbiter.thinking);
					if (!validation.ok) return validation;
				}
			}
			subagentArbiter = { ...subagentArbiter };
		}
	}

	let tabTitle = update.tabTitle;
	if (tabTitle !== undefined) {
		if (!isPlainObject(tabTitle)) {
			return { ok: false, error: "tabTitle must be an object" };
		}
		const validKeys = ["enabled", "model", "triggerAfter", "maxTitleLength"];
		const unknownTabTitleKeys = Object.keys(tabTitle).filter((key) => !validKeys.includes(key));
		if (unknownTabTitleKeys.length > 0) {
			return { ok: false, error: `Unknown tabTitle key(s): ${unknownTabTitleKeys.join(", ")}` };
		}
		if (Object.values(tabTitle).every((value) => value === undefined)) {
			return { ok: false, error: "tabTitle requires at least one setting to change" };
		}
		if (tabTitle.enabled !== undefined && typeof tabTitle.enabled !== "boolean") {
			return { ok: false, error: "tabTitle.enabled must be a boolean" };
		}
		for (const key of ["triggerAfter", "maxTitleLength"] as const) {
			const value = tabTitle[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
				return { ok: false, error: `tabTitle.${key} must be a positive whole number` };
			}
		}
		if (tabTitle.model !== undefined && tabTitle.model !== null) {
			if (typeof tabTitle.model !== "string" || !tabTitle.model.trim()) {
				return { ok: false, error: "tabTitle.model must be a non-empty exact provider/model string" };
			}
			const slash = tabTitle.model.indexOf("/");
			if (slash <= 0 || slash === tabTitle.model.length - 1 || /\s/.test(tabTitle.model)) {
				return { ok: false, error: "tabTitle.model must be an exact provider/model" };
			}
			const provider = tabTitle.model.slice(0, slash);
			const modelId = tabTitle.model.slice(slash + 1);
			const models = await modelRegistry.getAvailable();
			if (!models.some((candidate) => candidate.provider === provider && candidate.id === modelId)) {
				return { ok: false, error: `Tab title model not found: ${tabTitle.model}` };
			}
		}
		// `model: null` skips validation above: it removes the pinned model so title
		// generation restores Explore-agent routing.
		tabTitle = { ...tabTitle };
	}

	let trustedContextFolders: string[] | undefined;
	if (update.trustedContextFolders !== undefined) {
		try {
			trustedContextFolders = validateTrustedContextFolders(update.trustedContextFolders);
		} catch (error) {
			return { ok: false, error: (error as Error).message };
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

	const updatesContextTrustPolicy = update.autoLoadNestedContext !== undefined || trustedContextFolders !== undefined;

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

		try {
			// Phase 1: durably persist every ordinary setting before touching the
			// security-sensitive context trust policy.
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
			if (update.continueAfterAutoCompaction !== undefined) {
				settingsManager.setContinueAfterAutoCompaction(update.continueAfterAutoCompaction);
			}
			if (update.retryEnabled !== undefined) {
				settingsManager.setRetryEnabled(update.retryEnabled);
			}
			if (update.maxConcurrentSubagents !== undefined) {
				settingsManager.setMaxConcurrentSubagents(update.maxConcurrentSubagents);
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
			if (update.transport !== undefined) {
				settingsManager.setTransport(update.transport);
			}
			if (update.hideThinkingBlock !== undefined) {
				settingsManager.setHideThinkingBlock(update.hideThinkingBlock);
			}

			const warnings: string[] = [];
			if (update.enabledModels !== undefined) {
				if (settingsManager.hasProjectEnabledModelsOverride()) {
					warnings.push(
						"A project-level enabledModels value (.dreb/settings.json) takes precedence — this change to global settings will have no effect. Edit the project settings file to change it.",
					);
				}
				settingsManager.setEnabledModels(canonicalEnabledModels);
			}
			if (update.subagentArbiter !== undefined) {
				settingsManager.setGlobalSubagentArbiterSettings(subagentArbiter);
			}
			if (tabTitle !== undefined) {
				settingsManager.setGlobalTabTitleSettings(tabTitle);
			}
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

			await settingsManager.flush();
			const writeErrors = settingsManager.drainErrors();
			if (writeErrors.length > 0) {
				const detail = writeErrors.map((e) => `${e.scope}: ${e.error.message}`).join("; ");
				// Context trust has not yet been modified, so do not reload: doing so
				// could discard unrelated pending in-memory state.
				return { ok: false as const, error: `Failed to persist settings: ${detail}` };
			}

			// Phase 2: apply both context fields in one queued, atomic write only after
			// phase 1 is durably successful.
			if (updatesContextTrustPolicy) {
				settingsManager.setContextTrust({
					...(update.autoLoadNestedContext !== undefined ? { autoLoadNested: update.autoLoadNestedContext } : {}),
					...(trustedContextFolders !== undefined ? { trustedFolders: trustedContextFolders } : {}),
				});
				await settingsManager.flush();
				const ctxErrors = settingsManager.drainErrors();
				if (ctxErrors.length > 0) {
					const detail = ctxErrors.map((e) => `${e.scope}: ${e.error.message}`).join("; ");
					// The context write failed, so durable storage retains its previous,
					// fail-closed policy. Restore that policy in memory before returning.
					settingsManager.reload();
					return { ok: false as const, error: `Failed to persist settings: ${detail}` };
				}
			}

			const snapshot = getSettingsForRpc(settingsManager, await modelRegistry.getAvailable());
			return warnings.length > 0
				? { ok: true as const, settings: snapshot, warnings }
				: { ok: true as const, settings: snapshot };
		} catch (error) {
			if (updatesContextTrustPolicy) {
				// Setters and flush() can also fail synchronously. The same fail-closed
				// rollback is required before returning that persistence failure.
				settingsManager.reload();
			}
			return { ok: false as const, error: `Failed to persist settings: ${(error as Error).message}` };
		}
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
/**
 * Build the RPC-mode extension UI context. Extracted from `runRpcMode` so the
 * dialog request emission and response mapping (select/confirm/input/ask/editor)
 * can be unit-tested without spawning the CLI. `output` is the JSONL sink and
 * `pendingExtensionRequests` is the shared map keyed by request id.
 */
export interface PendingRpcExtensionRequest {
	request: RpcBlockingExtensionUIRequest;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

export function createRpcExtensionUIContext(
	output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
	pendingExtensionRequests: Map<string, PendingRpcExtensionRequest>,
	onAskStop: () => void = () => {},
): ExtensionUIContext {
	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
		onTimeout?: () => void,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let settled = false;

			const cleanup = (): boolean => {
				if (settled) return false;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
				output({ type: "extension_ui_response_handled", id });
				return true;
			};

			const onAbort = () => {
				if (!cleanup()) return;
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					if (!cleanup()) return;
					onTimeout?.();
					resolve(defaultValue);
				}, opts.timeout);
			}

			const rpcRequest = {
				type: "extension_ui_request",
				id,
				...request,
			} as RpcBlockingExtensionUIRequest;
			pendingExtensionRequests.set(id, {
				request: rpcRequest,
				resolve: (response: RpcExtensionUIResponse) => {
					if (!cleanup()) return;
					try {
						resolve(parseResponse(response));
					} catch (error) {
						reject(error);
					}
				},
				reject: (error) => {
					if (!cleanup()) return;
					reject(error);
				},
			});
			output(rpcRequest);
		});
	}

	// Serialize `ask` requests so at most one ask wizard is ever pending, mirroring
	// the TUI's single-dialog queue (`enqueueExtensionDialog`). Tool execution runs
	// in parallel, so a turn can issue several `ask_user` calls at once; without
	// this the Dashboard (which renders a single pending ask) would leave the extra
	// wizards invisible and their promises hanging until the turn aborts. The first
	// ask runs synchronously (preserving immediate request emission); later ones
	// wait in a FIFO. A call whose signal aborts while still queued settles with the
	// aborted value and never emits a request.
	let askInFlight = false;
	const askWaiters: Array<() => void> = [];
	const runNextAsk = () => {
		if (askInFlight) return;
		const next = askWaiters.shift();
		if (!next) return;
		askInFlight = true;
		next();
	};
	function serializeAsk<T>(
		opts: ExtensionUIDialogOptions | undefined,
		abortedValue: T,
		run: () => Promise<T>,
	): Promise<T> {
		const signal = opts?.signal;
		if (signal?.aborted) return Promise.resolve(abortedValue);
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (value: T) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			// A started run's outcome propagates verbatim (a host/protocol failure
			// must still reject so the ask_user tool reports it distinctly).
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			// While still queued, a signal abort removes this task and settles it
			// without ever emitting. Once started, createDialogPromise owns abort.
			const onAbort = () => {
				const index = askWaiters.indexOf(startTask);
				if (index === -1) return;
				askWaiters.splice(index, 1);
				finish(abortedValue);
			};
			const startTask = () => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) {
					finish(abortedValue);
					askInFlight = false;
					runNextAsk();
					return;
				}
				run()
					.then(finish, fail)
					.finally(() => {
						askInFlight = false;
						runNextAsk();
					});
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			askWaiters.push(startTask);
			runNextAsk();
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	return {
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

		ask: (request, opts) =>
			serializeAsk(opts, undefined, () =>
				createDialogPromise(
					opts,
					undefined,
					{
						method: "ask",
						title: request.title ?? "Question",
						questions: request.questions.map((q) => ({
							question: q.question,
							title: q.title,
							options: q.options,
							allowFreeText: q.allowFreeText,
							multiSelect: q.multiSelect,
							multiline: q.multiline,
						})),
						timeout: opts?.timeout,
						// Preserve the authoritative deadline across Dashboard reload,
						// resync, and drill-in hydration instead of restarting the full
						// duration whenever the wizard remounts.
						expiresAt: opts?.timeout ? Date.now() + opts.timeout : undefined,
					},
					(response) => {
						if ("cancelled" in response && response.cancelled) {
							onAskStop();
							return undefined;
						}
						const rawAnswers = (response as { answers?: unknown }).answers;
						if (!Array.isArray(rawAnswers)) {
							throw new Error("Invalid RPC ask response: answers must be an array");
						}
						const answers = rawAnswers.map((entry) => {
							const selected = (entry as { selected?: unknown })?.selected;
							const customText = (entry as { customText?: unknown })?.customText;
							const skipped = (entry as { skipped?: unknown })?.skipped;
							if (!Array.isArray(selected) || !selected.every((value) => typeof value === "string")) {
								throw new Error("Invalid RPC ask response: each answer's selected must be an array of strings");
							}
							if (customText !== undefined && typeof customText !== "string") {
								throw new Error("Invalid RPC ask response: customText must be a string");
							}
							const answered = selected.length > 0 || !!customText?.trim();
							return {
								selected,
								customText: customText || undefined,
								skipped: skipped === true || !answered,
							};
						});
						return { answers };
					},
					onAskStop,
				),
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

		editor: (title, prefill) =>
			createDialogPromise(undefined, undefined, { method: "editor", title, prefill }, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),

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
	};
}

/** Cancel every pending dialog during RPC host teardown. */
export function cancelPendingRpcExtensionRequests(
	pendingExtensionRequests: Map<string, PendingRpcExtensionRequest>,
): void {
	for (const [id, pending] of [...pendingExtensionRequests]) {
		pending.resolve({ type: "extension_ui_response", id, cancelled: true });
	}
}

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

	// Pending extension UI requests waiting for response. Keep the emitted
	// payload alongside its callbacks so recovery snapshots can reconstruct the
	// answer UI after a Dashboard reload or replay gap.
	const pendingExtensionRequests = new Map<string, PendingRpcExtensionRequest>();

	// Shutdown request flag
	let shutdownRequested = false;
	let dailyCostTracker: DailyCostTracker | undefined;
	let dailyCostTrackerPrimed = false;

	// Extension UI context uses the RPC protocol; built by a module-scope
	// factory so the dialog round trip is unit-testable (see createRpcExtensionUIContext).
	const createExtensionUIContext = (): ExtensionUIContext =>
		createRpcExtensionUIContext(output, pendingExtensionRequests, () => void session.abort());

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

	// Dashboard-launched runtimes (--ui dashboard) get events projected before
	// serialization: message_update's cumulative `message` and
	// `assistantMessageEvent.partial` fields are quadratic in response length on
	// the JSONL pipe, and no dashboard consumer reads them (deltas, message_end,
	// and get_dashboard_snapshot responses carry the authoritative data). Inline
	// image blocks are deduped over the process lifetime so each unique image
	// crosses stdout at most once — later occurrences become image_references
	// the dashboard resolves from its image cache (issue 495). Generic RPC
	// consumers keep the full protocol unchanged. Only the event stream is
	// projected — command responses (output() calls below) always stay complete.
	const dashboardEventProjector = session.uiType === "dashboard" ? createDashboardRpcEventProjector() : undefined;

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
		output(dashboardEventProjector ? dashboardEventProjector(event as unknown as Record<string, unknown>) : event);
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				const rejection = getBuiltinPromptRejection(command.message);
				if (rejection) return error(id, "prompt", rejection);
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				//
				// A subagent child (--ui agent) whose prompt settles without the agent
				// loop ever starting (e.g. an extension command consumed the task) would
				// otherwise idle forever: its parent waits on agent_end for completion.
				// Report that outcome as a late failure so the parent can terminate it.
				// The agent's own subscription delivers agent_start synchronously — the
				// session-level event queue would race the settled prompt promise.
				const isSubagentChild = session.uiType === "agent";
				let sawAgentStart = false;
				const unsubscribe = isSubagentChild
					? session.agent.subscribe((event) => {
							if (event.type === "agent_start") sawAgentStart = true;
						})
					: undefined;
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
					})
					.then(() => {
						unsubscribe?.();
						if (isSubagentChild && !sawAgentStart) {
							output(
								error(
									id,
									"prompt",
									"Prompt was handled without starting the agent loop (for example, an extension command consumed the task).",
								),
							);
						}
					})
					.catch((e) => {
						unsubscribe?.();
						output(error(id, "prompt", e.message));
					});
				return success(id, "prompt");
			}

			case "steer": {
				const rejection = getBuiltinPromptRejection(command.message);
				if (rejection) return error(id, "steer", rejection);
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				const rejection = getBuiltinPromptRejection(command.message);
				if (rejection) return error(id, "follow_up", rejection);
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

			case "reload": {
				await session.reload();
				return success(id, "reload");
			}

			case "dream": {
				return success(id, "dream", await runDreamForRpc(session, command.args));
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				return success(id, "get_state", getStateForRpc(session, modelFallbackMessage));
			}

			case "get_dashboard_snapshot": {
				const snapshotId = id ?? crypto.randomUUID();
				const data: RpcDashboardSnapshot = {
					snapshotId,
					state: getStateForRpc(session, modelFallbackMessage),
					messages: getDashboardMessagesForRpc(session),
					backgroundAgents: getBackgroundAgents().map(toRpcBackgroundAgentInfo),
					pendingExtensionUiRequests: [...pendingExtensionRequests.values()].map(({ request }) => request),
				};
				return success(id, "get_dashboard_snapshot", data);
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

			case "import_jsonl": {
				const cancelled = !(await session.importFromJsonl(command.inputPath));
				return success(id, "import_jsonl", { cancelled });
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
				const messages = session.getForkableMessages();
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
			// Command discovery (resource commands plus client-handled built-ins)
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

			case "steer_background_agent": {
				const rejection = getBuiltinPromptRejection(command.message);
				if (rejection) return error(id, "steer_background_agent", rejection);
				await steerBackgroundAgent(command.agentId, command.message);
				return success(id, "steer_background_agent");
			}

			case "get_background_agent_pending": {
				return success(
					id,
					"get_background_agent_pending",
					await getBackgroundAgentPendingSteering(command.agentId),
				);
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
				const result = await getFreshSettingsForRpc(session.settingsManager, session.modelRegistry);
				return result.ok ? success(id, "get_settings", result.settings) : error(id, "get_settings", result.error);
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

			case "evaluate_context_trust": {
				const result = evaluateContextTrustForRpc(session.settingsManager, command.path);
				return result.ok
					? success(id, "evaluate_context_trust", result.evaluation)
					: error(id, "evaluate_context_trust", result.error);
			}

			case "trust_context_folder": {
				const result = await trustContextFolderForRpc(session.settingsManager, command.path, session.modelRegistry);
				return result.ok
					? success(id, "trust_context_folder", result.result)
					: error(id, "trust_context_folder", result.error);
			}

			case "untrust_context_folder": {
				const result = await untrustContextFolderForRpc(
					session.settingsManager,
					command.path,
					session.modelRegistry,
				);
				return result.ok
					? success(id, "untrust_context_folder", result.result)
					: error(id, "untrust_context_folder", result.error);
			}

			case "remove_trusted_context_folder": {
				const result = await removeTrustedContextFolderForRpc(
					session.settingsManager,
					command.path,
					session.modelRegistry,
				);
				return result.ok
					? success(id, "remove_trusted_context_folder", result.result)
					: error(id, "remove_trusted_context_folder", result.error);
			}

			// =================================================================
			// Version
			// =================================================================

			case "get_version": {
				return success(id, "get_version", { version: VERSION });
			}

			case "get_commands": {
				return success(id, "get_commands", { commands: getCommandsForRpc(session) });
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
		cancelPendingRpcExtensionRequests(pendingExtensionRequests);

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
			// Emit the barrier before the response. Stdout preserves byte order even
			// when these lines arrive in separate chunks, so RuntimePool always records
			// the EventHub sequence before the response promise can resume.
			if (command.type === "get_dashboard_snapshot" && response.success) {
				const snapshot = response as Extract<RpcResponse, { command: "get_dashboard_snapshot"; success: true }>;
				output({ type: "dashboard_snapshot_barrier", snapshotId: snapshot.data.snapshotId });
			}
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
