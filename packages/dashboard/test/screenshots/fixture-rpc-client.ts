/**
 * A fake dreb RPC runtime that serves the screenshot scenario.
 *
 * The dashboard server talks to live sessions only through `RpcClient`. This
 * fake implements exactly the read-only subset the captured screens need, typed
 * against the real `RpcClient` signatures so an RPC interface change fails
 * `tsgo`. Every other member throws a descriptive error when called and is also
 * recorded in {@link FixtureRpcFailures}, so a screen that starts depending on a
 * new RPC call fails the capture loudly instead of rendering an empty panel.
 *
 * No process is spawned and no model is ever called.
 */

import { EventEmitter } from "node:events";
import { SessionManager, type SessionMessageEntry } from "@dreb/coding-agent";
import type {
	RpcBackgroundAgentInfo,
	RpcClient,
	RpcDashboardSnapshot,
	RpcEvent,
	RpcEventListener,
	RpcExitListener,
	RpcSessionState,
} from "@dreb/coding-agent/rpc";
import {
	AGENT_TYPES,
	AVAILABLE_MODELS,
	type LiveRuntimeScenario,
	type Scenario,
	SETTINGS,
	THINKING_LEVELS,
} from "./scenario.js";

type AgentMessage = SessionMessageEntry["message"];

/** RpcClient members the fixture runtime implements. */
type FixtureRpcMember =
	| "start"
	| "stop"
	| "onEvent"
	| "onExit"
	| "getState"
	| "getDashboardSnapshot"
	| "getMessages"
	| "getSessionStats"
	| "getLastAssistantText"
	| "listBackgroundAgents"
	| "getBackgroundAgentPending"
	| "getPerformanceStats"
	| "getGitBranch"
	| "getDailyCost"
	| "getCommands"
	| "getPendingMessages"
	| "getSettings"
	| "getAvailableModels"
	| "listAgentTypes"
	| "getVersion";

type FixtureRpcSurface = Pick<RpcClient, FixtureRpcMember>;

/** Collects every call to an RPC member the fixture runtime does not implement. */
export class FixtureRpcFailures {
	readonly messages: string[] = [];

	record(message: string): Error {
		this.messages.push(message);
		return new Error(message);
	}
}

/** Paths at which the harness materialized the scenario's session files. */
export interface MaterializedPaths {
	sessionFile(sessionId: string): string;
}

/** Live-runtime bindings a fixture runtime needs at construction. */
export interface FixtureRuntimeBinding {
	scenario: LiveRuntimeScenario;
	paths: MaterializedPaths;
}

function textOf(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

function totalDailyCost(scenario: Scenario): { cost: number; main: number; subagent: number } {
	const main = scenario.live.reduce((sum, runtime) => sum + runtime.cost, 0);
	const subagent = scenario.live.reduce((sum, runtime) => sum + (runtime.subagentCost ?? 0), 0);
	return { cost: main + subagent, main, subagent };
}

/**
 * Build one fake runtime. `binding` is absent for the hidden utility runtime the
 * server uses for settings/models/version, which owns no session.
 */
export function createFixtureRpcClient(options: {
	scenario: Scenario;
	binding?: FixtureRuntimeBinding;
	version: string;
	failures: FixtureRpcFailures;
}): RpcClient {
	const { scenario, binding, failures } = options;
	const events = new EventEmitter();
	let messages: AgentMessage[] | undefined;
	let snapshotCount = 0;

	const requireSession = (member: string): { runtime: LiveRuntimeScenario; transcript: AgentMessage[] } => {
		if (!binding) throw failures.record(`Screenshot utility runtime has no session for RpcClient.${member}()`);
		if (!messages) throw failures.record(`Screenshot runtime used RpcClient.${member}() before start()`);
		return { runtime: binding.scenario, transcript: messages };
	};

	const emit = (event: RpcEvent): void => {
		events.emit("event", event);
	};

	const state = (member: string): RpcSessionState => {
		const { runtime, transcript } = requireSession(member);
		const contextWindow = runtime.model.contextWindow;
		return {
			model: runtime.model,
			scopedModels: [],
			tasks: runtime.tasks.map((task) => ({ ...task })),
			usingSubscription: false,
			thinkingLevel: runtime.thinkingLevel,
			availableThinkingLevels: [...THINKING_LEVELS],
			isStreaming: runtime.status !== "idle",
			isRetrying: false,
			retryAttempt: 0,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			sessionFile: binding!.paths.sessionFile(runtime.session.id),
			sessionId: runtime.session.id,
			sessionName: sessionName(runtime),
			autoCompactionEnabled: true,
			messageCount: transcript.length,
			pendingMessageCount: 0,
			contextUsage: {
				tokens: runtime.contextTokens,
				contextWindow,
				percent: (runtime.contextTokens / contextWindow) * 100,
			},
		};
	};

	const backgroundAgents = (): RpcBackgroundAgentInfo[] =>
		(binding?.scenario.subagents ?? []).map((agent) => ({
			...agent.info,
			sessionFile: binding!.paths.sessionFile(agent.session.id),
		}));

	const implemented = {
		async start() {
			if (!binding) return;
			// Read the transcript back through the real session parser, exactly as a resumed runtime would.
			const sessionFile = binding.paths.sessionFile(binding.scenario.session.id);
			messages = SessionManager.open(sessionFile).buildSessionContext().messages;
			if (messages.length === 0) throw failures.record(`Screenshot session ${sessionFile} has no messages`);
		},
		async stop() {},
		onEvent(listener: RpcEventListener) {
			events.on("event", listener);
			return () => events.off("event", listener);
		},
		onExit(listener: RpcExitListener) {
			events.on("exit", listener);
			return () => events.off("exit", listener);
		},
		async getState() {
			return state("getState");
		},
		async getDashboardSnapshot(): Promise<RpcDashboardSnapshot> {
			const { runtime, transcript } = requireSession("getDashboardSnapshot");
			snapshotCount += 1;
			const snapshotId = `screenshot-${runtime.slug}-${snapshotCount}`;
			// The real RPC server emits the ordering barrier immediately before its response.
			emit({ type: "dashboard_snapshot_barrier", snapshotId });
			return {
				snapshotId,
				state: state("getDashboardSnapshot"),
				messages: transcript,
				backgroundAgents: backgroundAgents(),
				pendingExtensionUiRequests: runtime.pendingRequest ? [runtime.pendingRequest] : [],
			};
		},
		async getMessages() {
			return requireSession("getMessages").transcript;
		},
		async getSessionStats() {
			const { runtime, transcript } = requireSession("getSessionStats");
			const count = (role: AgentMessage["role"]) => transcript.filter((message) => message.role === role).length;
			const toolCalls = transcript.reduce(
				(sum, message) =>
					sum + (message.role === "assistant" ? message.content.filter((b) => b.type === "toolCall").length : 0),
				0,
			);
			const output = Math.round(runtime.tokensTotal * 0.04);
			const cacheRead = Math.round(runtime.tokensTotal * 0.6);
			return {
				sessionFile: binding!.paths.sessionFile(runtime.session.id),
				sessionId: runtime.session.id,
				userMessages: count("user"),
				assistantMessages: count("assistant"),
				toolCalls,
				toolResults: count("toolResult"),
				totalMessages: transcript.length,
				tokens: {
					input: runtime.tokensTotal - output - cacheRead,
					output,
					cacheRead,
					cacheWrite: 0,
					total: runtime.tokensTotal,
				},
				cost: runtime.cost,
				...(runtime.subagentCost === undefined ? {} : { subagentCost: runtime.subagentCost }),
				contextUsage: state("getSessionStats").contextUsage,
			};
		},
		async getLastAssistantText() {
			const { transcript } = requireSession("getLastAssistantText");
			for (let index = transcript.length - 1; index >= 0; index -= 1) {
				const value = textOf(transcript[index]);
				if (value) return value;
			}
			return null;
		},
		async listBackgroundAgents() {
			if (!binding) return [];
			return backgroundAgents();
		},
		async getBackgroundAgentPending(agentId: string) {
			if (!backgroundAgents().some((agent) => agent.agentId === agentId)) {
				throw failures.record(`Screenshot runtime has no background agent ${agentId}`);
			}
			return { steeringMode: "one-at-a-time" as const, pending: { steering: [], followUp: [] } };
		},
		async getPerformanceStats() {
			const performance = binding?.scenario.performance;
			return { models: performance ? [performance] : [] };
		},
		async getGitBranch() {
			return requireSession("getGitBranch").runtime.gitBranch;
		},
		async getDailyCost() {
			return totalDailyCost(scenario);
		},
		async getCommands() {
			return [];
		},
		async getPendingMessages() {
			return { steering: [], followUp: [] };
		},
		async getSettings() {
			return structuredClone(SETTINGS);
		},
		async getAvailableModels() {
			return AVAILABLE_MODELS.map((model) => ({ ...model }));
		},
		async listAgentTypes() {
			return AGENT_TYPES.map((agent) => ({ ...agent }));
		},
		async getVersion() {
			return options.version;
		},
	} satisfies FixtureRpcSurface;

	/** Replay the runtime's lifecycle so pool status, attention, and activity match the scenario. */
	const replayLifecycle = (): void => {
		if (!binding) return;
		const runtime = binding.scenario;
		emit({ type: "agent_start", model: { provider: runtime.model.provider, id: runtime.model.id } });
		if (runtime.pendingRequest) emit(runtime.pendingRequest);
		if (runtime.status === "idle") emit({ type: "agent_end", messages: [] });
	};

	/** Stream the scenario's live events, as a running session would after a browser connects. */
	const emitLiveEvents = (): void => {
		for (const event of binding?.scenario.liveEvents ?? []) emit(event);
	};

	const controls: FixtureRuntimeControls = { replayLifecycle, emitLiveEvents };
	const client = new Proxy(implemented, {
		get(target, property, receiver) {
			if (property === FIXTURE_CONTROLS) return controls;
			if (typeof property === "symbol" || property === "then" || property === "toJSON") {
				return Reflect.get(target, property, receiver);
			}
			if (property in target) return Reflect.get(target, property, receiver);
			return () => {
				throw failures.record(
					`Screenshot fixture runtime does not implement RpcClient.${property}() — add it to fixture-rpc-client.ts`,
				);
			};
		},
	});
	return client as unknown as RpcClient;
}

const FIXTURE_CONTROLS = Symbol("screenshot fixture runtime controls");

interface FixtureRuntimeControls {
	/** Replay status, attention, and activity events after the pool registered the runtime. */
	replayLifecycle(): void;
	/** Emit the scenario's live events once a browser is connected. */
	emitLiveEvents(): void;
}

/** Scenario controls of a client created by {@link createFixtureRpcClient}. */
export function fixtureControls(client: RpcClient): FixtureRuntimeControls {
	const controls = (client as unknown as Record<symbol, FixtureRuntimeControls | undefined>)[FIXTURE_CONTROLS];
	if (!controls) throw new Error("Not a screenshot fixture runtime");
	return controls;
}

function sessionName(runtime: LiveRuntimeScenario): string | undefined {
	for (const entry of runtime.session.entries) {
		if (entry.type === "session_info" && entry.name) return entry.name;
	}
	return undefined;
}
