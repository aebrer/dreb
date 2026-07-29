import { spawn } from "node:child_process";
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
	createSubagentToolDefinition,
	executeSingle,
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
const models = [workerModel, cheapModel];
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
		const result = await executeSingle(
			agents(),
			"arbiter-a",
			originalTask,
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
		expect(args[args.length - 1]).toBe(originalTask);
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
		let providerContext: unknown;
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
				providerContext = context;
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
		let resolveEvent!: (event: SubagentArbitrationEvent) => void;
		const eventPromise = new Promise<SubagentArbitrationEvent>((resolve) => {
			resolveEvent = resolve;
		});
		session.subscribe((event) => {
			if (event.type === "subagent_arbitration") resolveEvent(event);
		});
		const tool = parentAgent.state.tools.find((candidate) => candidate.name === "subagent");
		expect(tool).toBeDefined();
		await tool!.execute(
			"call",
			{ agent: "arbiter-a", task: "inspect CUSTOM_SECRET_123" },
			new AbortController().signal,
			() => {},
		);
		const event = await eventPromise;

		expect(JSON.stringify(providerContext)).not.toContain("CUSTOM_SECRET_123");
		expect(JSON.stringify(providerContext)).toContain("<REDACTED:custom_arbiter_secret>");
		expect(event).toMatchObject({ status: "success", agentId: expect.any(String), changed: [] });
		const persisted = sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "subagent_arbitration");
		expect(persisted).toMatchObject({ type: "custom", data: { type: "subagent_arbitration", status: "success" } });
		expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain("subagent_arbitration");
		session.dispose();
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
							{ agent: "arbiter-a", task: "first" },
							{ agent: "arbiter-a", task: "use {previous} now" },
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
			expect(requests[1].task).toContain("FIRST_OUTPUT");
			expect(requests[1].task).not.toContain("{previous}");
		}
	});

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
