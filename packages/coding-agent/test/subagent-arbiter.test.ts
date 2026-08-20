import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Agent } from "@dreb/agent-core";
import type { AssistantMessage, Model } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type {
	DispatchArbitrationRecord,
	DispatchArbitrationRequest,
	DispatchArbitrationResult,
} from "../src/core/dispatch-arbiter.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	type AgentTypeConfig,
	abortBackgroundAgents,
	createSubagentToolDefinition,
	executeSingle,
	getBackgroundAgents,
	type SubagentArbitrationEvent,
	type SubagentResult,
} from "../src/core/tools/subagent.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

const workerModel: Model<"openai-responses"> = {
	id: "worker",
	name: "Worker",
	api: "openai-responses",
	provider: "provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
};
const cheapModel: Model<"openai-responses"> = {
	...workerModel,
	id: "cheap",
	name: "Cheap",
	reasoning: false,
};
const slashfulModel: Model<"openai-responses"> = {
	...workerModel,
	provider: "gateway",
	id: "vendor/worker",
	name: "Gateway Worker",
};
const ambiguousSlashModel: Model<"openai-responses"> = {
	...workerModel,
	provider: "vendor",
	id: "worker",
	name: "Vendor Worker",
};
const models = [workerModel, cheapModel, slashfulModel, ambiguousSlashModel];
const GUIDE_SUBSECTIONS = [
	"Capabilities and thinking support",
	"Strengths",
	"Weaknesses and failure modes",
	"Recommended roles and tasks",
	"Discouraged roles and tasks",
	"Tool use, long context, and vision",
	"Latency and cost",
	"Local evidence",
	"External evidence and contrary findings",
	"Confidence and limitations",
	"Sources",
];

function routingGuide(modelId: string): string {
	return `---
schema_version: 1
generated_at: "2026-07-28T00:00:00Z"
covered_model_ids:
  - "${modelId}"
local_evidence: "cold-start"
analyzed_session_directories:
  - "~/.dreb/agent/subagent-sessions/"
session_date_range:
  start: null
  end: null
---
# Model Routing Guide
## Routing safeguards
Use role and cost fit.
## Model: ${modelId}
${GUIDE_SUBSECTIONS.map((heading) => `### ${heading}\nUnknown`).join("\n")}
`;
}

const registry = {
	getAll: () => models,
	find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
	getApiKey: vi.fn().mockResolvedValue("test-key"),
	getModelPromptSettings: () => undefined,
	authStorage: { hasAuth: () => true },
} as unknown as Parameters<typeof executeSingle>[8];

let tempCwd: string;
let outputs: string[];
let onSpawn: (() => void) | undefined;

function mockSpawn(): void {
	let index = 0;
	vi.mocked(spawn).mockImplementation(((_command: string, args: readonly string[]) => {
		onSpawn?.();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = new EventEmitter() as ReturnType<typeof spawn> & {
			stdout: PassThrough;
			stderr: PassThrough;
			killed: boolean;
		};
		proc.stdout = stdout;
		proc.stderr = stderr;
		proc.killed = false;
		proc.kill = vi.fn(() => true) as ReturnType<typeof spawn>["kill"];
		const provider = args[args.indexOf("--provider") + 1];
		const modelId = args[args.indexOf("--model") + 1];
		const thinking = args.includes("--thinking") ? args[args.indexOf("--thinking") + 1] : "high";
		const output = outputs[index++] ?? "done";
		process.nextTick(() => {
			stdout.write(
				`${JSON.stringify({ type: "agent_start", model: { provider, id: modelId }, thinkingLevel: thinking })}\n`,
			);
			stdout.write(
				`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" } })}\n`,
			);
			stdout.end();
			stderr.end();
			proc.emit("close", 0);
		});
		return proc;
	}) as unknown as typeof spawn);
}

function agents(): Map<string, AgentTypeConfig> {
	return new Map([
		[
			"arbiter-a",
			{
				name: "arbiter-a",
				description: "research",
				tools: "read,grep",
				model: "provider/worker",
				systemPrompt: "A prompt",
			},
		],
		[
			"arbiter-b",
			{
				name: "arbiter-b",
				description: "implementation",
				tools: "read,edit,write",
				model: "provider/cheap",
				systemPrompt: "B prompt",
			},
		],
	]);
}

beforeEach(() => {
	tempCwd = mkdtempSync(join(tmpdir(), "dreb-subagent-arbiter-"));
	const agentDir = join(tempCwd, ".dreb", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "arbiter-a.md"),
		"---\nname: arbiter-a\ndescription: research\ntools: read,grep\nmodel: provider/worker\n---\nA prompt\n",
	);
	writeFileSync(
		join(agentDir, "arbiter-b.md"),
		"---\nname: arbiter-b\ndescription: implementation\ntools: read,edit,write\nmodel: provider/cheap\n---\nB prompt\n",
	);
	outputs = ["done"];
	onSpawn = undefined;
	vi.mocked(spawn).mockReset();
	mockSpawn();
});

afterEach(() => {
	abortBackgroundAgents();
	rmSync(tempCwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("pre-spawn subagent arbitration", () => {
	test("applies only the final agent/model/thinking and records success before spawn", async () => {
		const order: string[] = [];
		onSpawn = () => order.push("spawn");
		const records: DispatchArbitrationRecord[] = [];
		let arbitrationRequest: DispatchArbitrationRequest | undefined;
		const originalTask = "Implement exactly this task";
		const childCwd = join(tempCwd, "direct-child");
		mkdirSync(childCwd);
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			originalTask,
			childCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			join(tempCwd, "session"),
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async (request) => {
					arbitrationRequest = request;
					return {
						enabled: true,
						ok: true,
						decision: { agent: "arbiter-b", model: "provider/cheap", thinking: "off" },
						changed: ["agent", "model", "thinking"],
					};
				},
				onRecord: (record) => {
					order.push("record");
					records.push(record);
				},
				defaultThinkingLevel: "high",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.agent).toBe("arbiter-b");
		expect(result.task).toBe(originalTask);
		expect(arbitrationRequest?.cwd).toBe(childCwd);
		expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ cwd: childCwd });
		expect(arbitrationRequest?.agents.find((agent) => agent.name === "arbiter-b")?.tools).toEqual([
			"read",
			"edit",
			"write",
			"search",
			"skill",
			"tasks_update",
		]);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "success", changed: ["agent", "model", "thinking"] });
		expect(order.slice(0, 2)).toEqual(["record", "spawn"]);
		const args = vi.mocked(spawn).mock.calls[0][1] as string[];
		expect(args).toContain("arbiter-b");
		expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2)).toEqual([
			"--provider",
			"provider",
		]);
		expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "cheap"]);
		expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual(["--thinking", "off"]);
		expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read,edit,write"]);
		expect(args.slice(args.indexOf("--append-system-prompt"), args.indexOf("--append-system-prompt") + 2)).toEqual([
			"--append-system-prompt",
			"B prompt",
		]);
		expect(args).not.toContain("A prompt");
		expect(args[args.length - 1]).toBe(originalTask);
	});

	test.each([
		{
			label: "keeps the fallback proposal",
			decision: { agent: "arbiter-a", model: "provider/worker", thinking: "high" },
			changed: [],
			expectedSummary: 'using "provider/worker".',
		},
		{
			label: "changes the fallback proposal",
			decision: { agent: "arbiter-a", model: "provider/cheap", thinking: "off" },
			changed: ["model"],
			expectedSummary: 'proposal resolved to "provider/worker" before arbitration selected "provider/cheap".',
		},
	] as const)("preserves loud proposal fallback diagnostics when arbitration $label", async (route) => {
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"route after fallback",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			join(tempCwd, "session"),
			"worker",
			["provider/missing"],
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async () => ({
					enabled: true,
					ok: true,
					decision: route.decision,
					changed: [...route.changed],
				}),
				onRecord: vi.fn(),
				defaultThinkingLevel: "high",
			},
		);

		expect(result).toMatchObject({ exitCode: 0, model: route.decision.model });
		expect(result.output).toContain(
			'[WARNING: Proposal resolution: Agent preferred models were unavailable. Falling back to parent model "worker".]',
		);
		expect(result.output).toContain("[MODEL FALLBACK: skipped 1 unavailable model(s);");
		expect(result.output).toContain(route.expectedSummary);
		expect(result.output).toContain("- provider/missing:");
		expect(result.output).toContain("done");
	});

	test.each([
		{
			label: "agent only",
			decision: { agent: "arbiter-b", model: "provider/worker", thinking: "high" },
			changed: ["agent"],
			expectedTools: "read,edit,write",
			expectedPrompt: "B prompt",
			unexpectedPrompt: "A prompt",
		},
		{
			label: "model only",
			decision: { agent: "arbiter-a", model: "gateway/vendor/worker", thinking: "high" },
			changed: ["model"],
			expectedTools: "read,grep",
			expectedPrompt: "A prompt",
			unexpectedPrompt: "B prompt",
		},
		{
			label: "thinking only",
			decision: { agent: "arbiter-a", model: "provider/worker", thinking: "low" },
			changed: ["thinking"],
			expectedTools: "read,grep",
			expectedPrompt: "A prompt",
			unexpectedPrompt: "B prompt",
		},
	] as const)("applies an arbitration change to $label", async (route) => {
		const records: DispatchArbitrationRecord[] = [];
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"change one route field",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			join(tempCwd, "session"),
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async () => ({
					enabled: true,
					ok: true,
					decision: route.decision,
					changed: [...route.changed],
				}),
				onRecord: (record) => records.push(record),
				defaultThinkingLevel: "high",
			},
		);

		expect(result).toMatchObject({
			exitCode: 0,
			agent: route.decision.agent,
			model: route.decision.model,
			thinking: route.decision.thinking,
		});
		expect(records).toEqual([
			expect.objectContaining({
				status: "success",
				proposed: { agent: "arbiter-a", model: "provider/worker", thinking: "high" },
				final: route.decision,
				changed: [...route.changed],
			}),
		]);
		const args = vi.mocked(spawn).mock.calls[0][1] as string[];
		const [expectedProvider, ...modelParts] = route.decision.model.split("/");
		expect(args).toContain(route.decision.agent);
		expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2)).toEqual([
			"--provider",
			expectedProvider,
		]);
		expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
			"--model",
			modelParts.join("/"),
		]);
		expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual([
			"--thinking",
			route.decision.thinking,
		]);
		expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
			"--tools",
			route.expectedTools,
		]);
		expect(args.slice(args.indexOf("--append-system-prompt"), args.indexOf("--append-system-prompt") + 2)).toEqual([
			"--append-system-prompt",
			route.expectedPrompt,
		]);
		expect(args).not.toContain(route.unexpectedPrompt);
	});

	test("preserves the exact selected provider when the raw model ID contains a slash", async () => {
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"route exactly",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			join(tempCwd, "session"),
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async () => ({
					enabled: true,
					ok: true,
					decision: { agent: "arbiter-b", model: "gateway/vendor/worker", thinking: "high" },
					changed: ["agent", "model"],
				}),
				onRecord: vi.fn(),
			},
		);

		expect(result).toMatchObject({ exitCode: 0, model: "gateway/vendor/worker" });
		const args = vi.mocked(spawn).mock.calls[0][1] as string[];
		expect(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2)).toEqual(["--provider", "gateway"]);
		expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "vendor/worker"]);
	});

	test("fails closed and never spawns when arbitration fails", async () => {
		const records: DispatchArbitrationRecord[] = [];
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"task",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			undefined,
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async () => ({ enabled: true, ok: false, code: "invalid_guide", error: "guide failed" }),
				onRecord: (record) => records.push(record),
			},
		);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("guide failed");
		expect(records).toHaveLength(1);
		expect(records[0].status).toBe("failure");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("turns unexpected arbiter exceptions into a safe failure record without spawn", async () => {
		const records: DispatchArbitrationRecord[] = [];
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"task",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			undefined,
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				arbitrate: async () => {
					throw new Error("raw internal detail");
				},
				onRecord: (record) => records.push(record),
			},
		);
		expect(result).toMatchObject({
			exitCode: 1,
			errorMessage: "Dispatch arbiter failed internally before child spawn.",
		});
		expect(records).toMatchObject([{ status: "failure", errorCode: "internal_error" }]);
		expect(JSON.stringify(records)).not.toContain("raw internal detail");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("disabled arbitration preserves omission and current routing", async () => {
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			"task",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"provider",
			registry,
			join(tempCwd, "session"),
			"worker",
			undefined,
			undefined,
			undefined,
			undefined,
			{ arbitrate: async () => ({ enabled: false }), onRecord: vi.fn() },
		);
		expect(result.exitCode).toBe(0);
		const args = vi.mocked(spawn).mock.calls[0][1] as string[];
		expect(args).toContain("arbiter-a");
		expect(args).not.toContain("--thinking");
	});

	test("AgentSession persists safe arbitration metadata outside reconstructed LLM context", async () => {
		const guidePath = join(tempCwd, "routing-guide.md");
		writeFileSync(guidePath, routingGuide("provider/worker"));
		const childRepo = join(tempCwd, "child-repo");
		const init = spawnSync("git", ["init", "--initial-branch=child-route", childRepo], { encoding: "utf8" });
		expect(init.status, init.stderr).toBe(0);
		const childCwd = join(childRepo, "packages", "nested");
		mkdirSync(childCwd, { recursive: true });
		writeFileSync(join(childCwd, "untracked.txt"), "child repository change");
		const nonGitCwd = join(tempCwd, "not-a-repo");
		mkdirSync(nonGitCwd);
		const parentAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: workerModel, systemPrompt: "parent", tools: [] },
		});
		vi.spyOn(parentAgent, "prompt").mockResolvedValue(undefined as never);
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			subagentArbiter: { enabled: true, model: "provider/worker", thinking: "high", guidePath },
			secretOutputPatterns: [{ name: "custom_arbiter_secret", pattern: "CUSTOM_SECRET_[0-9]+" }],
		});
		const providerContexts: unknown[] = [];
		const session = new AgentSession({
			agent: parentAgent,
			sessionManager,
			settingsManager,
			cwd: tempCwd,
			modelRegistry: registry as never,
			resourceLoader: createTestResourceLoader(),
			scopedModels: [{ model: workerModel }],
			initialActiveToolNames: ["subagent"],
			dispatchArbiterComplete: async (_model, context) => {
				providerContexts.push(context);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ agent: "arbiter-a", model: "provider/worker", thinking: "high" }),
						},
					],
				} as AssistantMessage;
			},
		});
		const events: SubagentArbitrationEvent[] = [];
		let resolveEvents!: () => void;
		const eventsPromise = new Promise<void>((resolve) => {
			resolveEvents = resolve;
		});
		session.subscribe((event) => {
			if (event.type !== "subagent_arbitration") return;
			events.push(event);
			if (events.length === 2) resolveEvents();
		});
		const tool = parentAgent.state.tools.find((candidate) => candidate.name === "subagent");
		expect(tool).toBeDefined();
		await tool!.execute(
			"call",
			{
				tasks: [
					{ agent: "arbiter-a", task: "inspect CUSTOM_SECRET_123", cwd: childCwd },
					{ agent: "arbiter-a", task: "inspect a non-git directory", cwd: nonGitCwd },
				],
			},
			new AbortController().signal,
			() => {},
		);
		await eventsPromise;
		const arbiterInputs = providerContexts.map((providerContext) => {
			const providerMessage = (providerContext as { messages: Array<{ content: string }> }).messages[0].content;
			return JSON.parse(providerMessage.slice(providerMessage.indexOf("\n") + 1)) as {
				child: { cwd: string };
				repository: { repo?: string; cwd: string; branch?: string; dirtyCount?: number };
			};
		});
		const nestedRepoInput = arbiterInputs.find((input) => input.child.cwd === childCwd);
		const nonGitInput = arbiterInputs.find((input) => input.child.cwd === nonGitCwd);

		expect(nestedRepoInput?.repository).toEqual({
			repo: "child-repo",
			cwd: childCwd,
			branch: "child-route",
			dirtyCount: 1,
		});
		expect(nonGitInput?.repository).toEqual({ cwd: nonGitCwd });
		expect(vi.mocked(spawn).mock.calls.map((call) => call[2]?.cwd)).toEqual(
			expect.arrayContaining([childCwd, nonGitCwd]),
		);
		expect(JSON.stringify(providerContexts)).not.toContain("CUSTOM_SECRET_123");
		expect(JSON.stringify(providerContexts)).toContain("<REDACTED:custom_arbiter_secret>");
		expect(events).toHaveLength(2);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "success", agentId: expect.any(String), changed: [] }),
			]),
		);
		const persisted = sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "subagent_arbitration");
		expect(persisted).toMatchObject({ type: "custom", data: { type: "subagent_arbitration", status: "success" } });
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain("subagent_arbitration");
		session.dispose();
	});

	test("AgentSession persists a scrubbed authentication failure and never spawns", async () => {
		const guidePath = join(tempCwd, "routing-guide.md");
		writeFileSync(guidePath, routingGuide("provider/worker"));
		const parentAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: workerModel, systemPrompt: "parent", tools: [] },
		});
		vi.spyOn(parentAgent, "prompt").mockResolvedValue(undefined as never);
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory({
			subagentArbiter: { enabled: true, model: "provider/worker", thinking: "high", guidePath },
			secretOutputPatterns: [{ name: "auth_secret", pattern: "AUTH_SECRET_[0-9]+" }],
		});
		const failingRegistry = {
			...registry,
			getApiKey: vi.fn().mockRejectedValue(new Error("credential lookup failed: AUTH_SECRET_123")),
		};
		const complete = vi.fn();
		const session = new AgentSession({
			agent: parentAgent,
			sessionManager,
			settingsManager,
			cwd: tempCwd,
			modelRegistry: failingRegistry as never,
			resourceLoader: createTestResourceLoader(),
			scopedModels: [{ model: workerModel }],
			initialActiveToolNames: ["subagent"],
			dispatchArbiterComplete: complete,
		});
		let resolveEvent!: (event: SubagentArbitrationEvent) => void;
		const eventPromise = new Promise<SubagentArbitrationEvent>((resolve) => {
			resolveEvent = resolve;
		});
		session.subscribe((event) => {
			if (event.type === "subagent_arbitration") resolveEvent(event);
		});

		const tool = parentAgent.state.tools.find((candidate) => candidate.name === "subagent");
		expect(tool).toBeDefined();
		await tool!.execute("call", { agent: "arbiter-a", task: "inspect auth" }, new AbortController().signal, () => {});
		const event = await eventPromise;

		expect(event).toMatchObject({
			status: "failure",
			final: null,
			errorCode: "arbiter_model",
			errorMessage: expect.stringContaining("<REDACTED:auth_secret>"),
		});
		expect(JSON.stringify(event)).not.toContain("AUTH_SECRET_123");
		expect(complete).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		const persisted = sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "subagent_arbitration");
		expect(persisted).toMatchObject({
			type: "custom",
			data: { status: "failure", final: null, errorCode: "arbiter_model" },
		});
		expect(JSON.stringify(persisted)).not.toContain("AUTH_SECRET_123");
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain("subagent_arbitration");
		session.dispose();
	});

	test("updates the background registry to the final agent before child lifecycle events", async () => {
		let agentId: string | undefined;
		let registryAtArbitration: ReturnType<typeof getBackgroundAgents>[number] | undefined;
		let resolveCompleted!: (result: SubagentResult) => void;
		const completed = new Promise<SubagentResult>((resolve) => {
			resolveCompleted = resolve;
		});
		const tool = createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "provider",
			parentModel: () => "worker",
			modelRegistry: registry,
			defaultThinkingLevel: () => "high",
			arbitrate: async () => ({
				enabled: true,
				ok: true,
				decision: { agent: "arbiter-b", model: "provider/cheap", thinking: "off" },
				changed: ["agent", "model", "thinking"],
			}),
			onBackgroundStart: (id) => {
				agentId = id;
			},
			onArbitration: () => {
				registryAtArbitration = getBackgroundAgents().find((entry) => entry.agentId === agentId);
			},
			onBackgroundComplete: (_id, result) => resolveCompleted(result),
		});

		await tool.execute(
			"call",
			{ agent: "arbiter-a", task: "route to the implementation agent" },
			new AbortController().signal,
			() => {},
			undefined as never,
		);
		const result = await completed;

		expect(registryAtArbitration).toMatchObject({
			agentId,
			agentType: "arbiter-b",
			status: "running",
			arbitrations: [{ status: "success", final: { agent: "arbiter-b" } }],
		});
		expect(result).toMatchObject({ agent: "arbiter-b", exitCode: 0 });
	});

	test("aborts in-flight arbitration through the background lifecycle before spawn", async () => {
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let resolveCompleted!: (value: { result: SubagentResult; cancelled: boolean }) => void;
		const completed = new Promise<{ result: SubagentResult; cancelled: boolean }>((resolve) => {
			resolveCompleted = resolve;
		});
		const events: SubagentArbitrationEvent[] = [];
		const tool = createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "provider",
			parentModel: () => "worker",
			modelRegistry: registry,
			arbitrate: async (_request, signal) => {
				markStarted();
				return new Promise<DispatchArbitrationResult>((resolve) => {
					if (!signal) throw new Error("expected background abort signal");
					signal.addEventListener(
						"abort",
						() =>
							resolve({
								enabled: true,
								ok: false,
								code: "aborted",
								error: "Dispatch arbitration was aborted before child spawn.",
							}),
						{ once: true },
					);
				});
			},
			onArbitration: (event) => events.push(event),
			onBackgroundComplete: (_id, result, cancelled) => resolveCompleted({ result, cancelled }),
		});

		await tool.execute(
			"call",
			{ agent: "arbiter-a", task: "cancel while routing" },
			new AbortController().signal,
			() => {},
			undefined as never,
		);
		await started;
		abortBackgroundAgents();
		const completion = await completed;

		expect(completion.cancelled).toBe(true);
		expect(completion.result).toMatchObject({ exitCode: 1, errorMessage: expect.stringContaining("aborted") });
		expect(events).toMatchObject([{ status: "failure", errorCode: "aborted", final: null }]);
		expect(spawn).not.toHaveBeenCalled();
	});

	test("rejects an escaping cwd before arbitration and child spawn", async () => {
		const arbitrate = vi.fn();
		const tool = createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "provider",
			parentModel: () => "worker",
			modelRegistry: registry,
			arbitrate,
			onBackgroundComplete: vi.fn(),
		});
		const result = await tool.execute(
			"call",
			{ tasks: [{ agent: "arbiter-a", task: "one", cwd: "../escape" }] },
			new AbortController().signal,
			() => {},
			undefined as never,
		);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("No agents were launched"),
		});
		expect(arbitrate).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	test.each(["parallel", "chain"] as const)("runs once per actual %s child spawn", async (mode) => {
		outputs = mode === "chain" ? ["FIRST_OUTPUT", "SECOND_OUTPUT"] : ["one", "two"];
		vi.mocked(spawn).mockReset();
		mockSpawn();
		const requests: DispatchArbitrationRequest[] = [];
		const events: SubagentArbitrationEvent[] = [];
		const completions: SubagentResult[] = [];
		let resolveComplete!: () => void;
		const completed = new Promise<void>((resolve) => {
			resolveComplete = resolve;
		});
		const arbitrate = async (request: DispatchArbitrationRequest): Promise<DispatchArbitrationResult> => {
			requests.push(request);
			return { enabled: true, ok: true, decision: request.proposed, changed: [] };
		};
		const tool = createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "provider",
			parentModel: () => "worker",
			modelRegistry: registry,
			defaultThinkingLevel: () => "high",
			getAgentModelsForAgent: (name) => (name === "arbiter-b" ? ["provider/settings-cheap"] : undefined),
			arbitrate,
			onArbitration: (event) => events.push(event),
			onBackgroundComplete: (_id, result) => {
				completions.push(result);
				if ((mode === "parallel" && completions.length === 2) || mode === "chain") resolveComplete();
			},
		});
		const chainCwds = [join(tempCwd, "chain-first"), join(tempCwd, "chain-second")];
		if (mode === "chain") {
			for (const cwd of chainCwds) mkdirSync(cwd);
		}
		const params =
			mode === "parallel"
				? {
						tasks: [
							{ agent: "arbiter-a", task: "one" },
							{ agent: "arbiter-a", task: "two" },
						],
					}
				: {
						chain: [
							{ agent: "arbiter-a", task: "first", cwd: chainCwds[0] },
							{ agent: "arbiter-a", task: "use {previous} now", cwd: chainCwds[1] },
						],
					};
		await tool.execute("call", params, new AbortController().signal, () => {}, undefined as never);
		await completed;

		expect(requests).toHaveLength(2);
		expect(requests[0].agents.find((agent) => agent.name === "arbiter-b")?.modelDefaults).toEqual([
			"provider/settings-cheap",
		]);
		expect(events).toHaveLength(2);
		expect(spawn).toHaveBeenCalledTimes(2);
		if (mode === "chain") {
			expect(requests[0].step).toBe(1);
			expect(requests[1].step).toBe(2);
			expect(requests.map((request) => request.cwd)).toEqual(chainCwds);
			expect(vi.mocked(spawn).mock.calls.map((call) => call[2]?.cwd)).toEqual(chainCwds);
			expect(requests[1].task).toContain("FIRST_OUTPUT");
			expect(requests[1].task).not.toContain("{previous}");
		}
	});

	test.each([
		{ configuredLimit: undefined, expectedLimit: 4 },
		{ configuredLimit: 1, expectedLimit: 1 },
	])(
		"bounds pending parallel arbitration at $expectedLimit concurrent children",
		async ({ configuredLimit, expectedLimit }) => {
			let active = 0;
			let maxActive = 0;
			let startedCount = 0;
			const releases: Array<() => void> = [];
			const events: SubagentArbitrationEvent[] = [];
			let completedCount = 0;
			let resolveCompleted!: () => void;
			const completed = new Promise<void>((resolve) => {
				resolveCompleted = resolve;
			});
			const tool = createSubagentToolDefinition(tempCwd, {
				maxConcurrentSubagents: configuredLimit,
				parentProvider: () => "provider",
				parentModel: () => "worker",
				modelRegistry: registry,
				defaultThinkingLevel: () => "high",
				arbitrate: async (request) => {
					active += 1;
					startedCount += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise<void>((resolve) => releases.push(resolve));
					active -= 1;
					return { enabled: true, ok: true, decision: request.proposed, changed: [] };
				},
				onArbitration: (event) => events.push(event),
				onBackgroundComplete: () => {
					completedCount += 1;
					if (completedCount === 8) resolveCompleted();
				},
			});
			expect(tool.description).toContain(`max ${expectedLimit} concurrent`);

			await tool.execute(
				"call",
				{
					tasks: Array.from({ length: 8 }, (_, index) => ({
						agent: "arbiter-a",
						task: `parallel-${index}`,
					})),
				},
				new AbortController().signal,
				() => {},
				undefined as never,
			);

			await vi.waitFor(() => expect(startedCount).toBe(expectedLimit));
			expect(maxActive).toBe(expectedLimit);
			while (startedCount < 8) {
				const previousStarted = startedCount;
				for (const release of releases.splice(0)) release();
				await vi.waitFor(() => expect(startedCount).toBe(Math.min(previousStarted + expectedLimit, 8)));
				expect(maxActive).toBe(expectedLimit);
			}
			for (const release of releases.splice(0)) release();
			await completed;

			expect(maxActive).toBe(expectedLimit);
			expect(events).toHaveLength(8);
			expect(spawn).toHaveBeenCalledTimes(8);
		},
	);

	test("stops a chain before the failed arbitration spawn and every later step", async () => {
		outputs = ["FIRST_OUTPUT"];
		vi.mocked(spawn).mockReset();
		mockSpawn();
		const requests: DispatchArbitrationRequest[] = [];
		const events: SubagentArbitrationEvent[] = [];
		let finalResult: SubagentResult | undefined;
		let resolveComplete!: () => void;
		const completed = new Promise<void>((resolve) => {
			resolveComplete = resolve;
		});
		const tool = createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "provider",
			parentModel: () => "worker",
			modelRegistry: registry,
			defaultThinkingLevel: () => "high",
			arbitrate: async (request) => {
				requests.push(request);
				if (request.step === 2) {
					return { enabled: true, ok: false, code: "invalid_guide", error: "guide changed" };
				}
				return { enabled: true, ok: true, decision: request.proposed, changed: [] };
			},
			onArbitration: (event) => events.push(event),
			onBackgroundComplete: (_id, result) => {
				finalResult = result;
				resolveComplete();
			},
		});

		await tool.execute(
			"call",
			{
				chain: [
					{ agent: "arbiter-a", task: "first" },
					{ agent: "arbiter-a", task: "use {previous} second" },
					{ agent: "arbiter-a", task: "never run {previous}" },
				],
			},
			new AbortController().signal,
			() => {},
			undefined as never,
		);
		await completed;

		expect(requests.map((request) => request.step)).toEqual([1, 2]);
		expect(requests[1].task).toContain("FIRST_OUTPUT");
		expect(events.map((event) => event.status)).toEqual(["success", "failure"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(finalResult).toMatchObject({ exitCode: 1, errorMessage: expect.stringContaining("guide changed") });
	});
});
