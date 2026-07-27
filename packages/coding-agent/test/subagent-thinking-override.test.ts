import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ThinkingLevel } from "@dreb/agent-core";
import type { Model } from "@dreb/ai";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	type AgentTypeConfig,
	createSubagentToolDefinition,
	executeSingle,
	resolveSubagentThinkingOverride,
	type SubagentResult,
	subagentToolDefinition,
} from "../src/core/tools/subagent.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

const reasoningModel: Model<"openai-responses"> = {
	id: "gpt-5.6-test",
	name: "Reasoning test model",
	api: "openai-responses",
	provider: "test-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8192,
};

const nonReasoningModel: Model<"openai-responses"> = {
	...reasoningModel,
	id: "simple-model",
	name: "Simple test model",
	reasoning: false,
};

const nonXhighModel: Model<"openai-responses"> = {
	...reasoningModel,
	id: "ordinary-reasoning-model",
	name: "Ordinary reasoning model",
};

const models = [reasoningModel, nonReasoningModel, nonXhighModel];
const registry = {
	getAll: () => models,
	find: (provider: string, modelId: string) =>
		models.find((model) => model.provider === provider && model.id === modelId),
	authStorage: { hasAuth: () => true },
} as unknown as Parameters<typeof executeSingle>[8];

let tempCwd: string;

function mockSpawnResult(thinkingLevels: ThinkingLevel | ThinkingLevel[] = "medium", output = "done"): void {
	let spawnIndex = 0;
	vi.mocked(spawn).mockImplementation((() => {
		const thinkingLevel = Array.isArray(thinkingLevels)
			? (thinkingLevels[spawnIndex++] ?? thinkingLevels[thinkingLevels.length - 1])
			: thinkingLevels;
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

		process.nextTick(() => {
			stdout.write(
				`${JSON.stringify({
					type: "agent_start",
					model: { provider: reasoningModel.provider, id: reasoningModel.id },
					thinkingLevel,
				})}\n`,
			);
			stdout.write(
				`${JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" },
				})}\n`,
			);
			stdout.end();
			stderr.end();
			proc.emit("close", 0);
		});
		return proc;
	}) as typeof spawn);
}

function testAgents(model?: string): Map<string, AgentTypeConfig> {
	return new Map([
		[
			"thinking-test",
			{
				name: "thinking-test",
				description: "Thinking override test agent",
				model,
				systemPrompt: "Test prompt",
			},
		],
	]);
}

beforeEach(() => {
	vi.mocked(spawn).mockReset();
	tempCwd = mkdtempSync(join(tmpdir(), "dreb-subagent-thinking-"));
	const agentDir = join(tempCwd, ".dreb", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "thinking-test.md"),
		"---\nname: thinking-test\ndescription: Thinking override test agent\nmodel: test-provider/gpt-5.6-test\n---\nTest prompt\n",
	);
});

afterEach(() => {
	rmSync(tempCwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("subagent thinking schema", () => {
	test.each(["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[])(
		"accepts %s in single, parallel, and chain modes",
		(thinking) => {
			expect(Value.Check(subagentToolDefinition.parameters, { task: "single", thinking })).toBe(true);
			expect(Value.Check(subagentToolDefinition.parameters, { tasks: [{ task: "parallel", thinking }] })).toBe(true);
			expect(Value.Check(subagentToolDefinition.parameters, { chain: [{ task: "chain", thinking }] })).toBe(true);
		},
	);

	test("rejects unsupported thinking levels", () => {
		expect(Value.Check(subagentToolDefinition.parameters, { task: "work", thinking: "extreme" })).toBe(false);
		expect(Value.Check(subagentToolDefinition.parameters, { tasks: [{ task: "work", thinking: "extreme" }] })).toBe(
			false,
		);
	});
});

describe("thinking precedence", () => {
	test("per-task values override top-level values", () => {
		expect(resolveSubagentThinkingOverride("high", "low")).toBe("high");
	});

	test("top-level values are inherited when the task omits thinking", () => {
		expect(resolveSubagentThinkingOverride(undefined, "low")).toBe("low");
	});

	test("omission preserves undefined", () => {
		expect(resolveSubagentThinkingOverride(undefined, undefined)).toBeUndefined();
	});
});

describe("executeSingle thinking validation and child arguments", () => {
	test("passes the requested level but reports the child-effective metadata", async () => {
		mockSpawnResult("low");
		const result = await executeSingle(
			testAgents("test-provider/gpt-5.6-test"),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"test-provider",
			registry,
			undefined,
			reasoningModel.id,
			undefined,
			undefined,
			undefined,
			"high",
		);

		expect(result.exitCode).toBe(0);
		expect(result.model).toBe("test-provider/gpt-5.6-test");
		expect(result.thinking).toBe("low");
		const args = vi.mocked(spawn).mock.calls[0][1];
		expect(args.filter((arg) => arg === "--thinking")).toHaveLength(1);
		expect(args).toContain("high");
	});

	test("omission adds no child argument but still captures the child's effective default", async () => {
		mockSpawnResult("medium");
		const result = await executeSingle(
			testAgents("test-provider/gpt-5.6-test"),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"test-provider",
			registry,
		);

		expect(result.thinking).toBe("medium");
		expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain("--thinking");
	});

	test("resolves an inherited parent model before validating thinking", async () => {
		mockSpawnResult("high");
		const result = await executeSingle(
			testAgents(),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"test-provider",
			registry,
			undefined,
			reasoningModel.id,
			undefined,
			undefined,
			undefined,
			"high",
		);

		expect(result.exitCode).toBe(0);
		const args = vi.mocked(spawn).mock.calls[0][1];
		expect(args).toContain("--model");
		expect(args).toContain(reasoningModel.id);
		expect(args).toContain("--provider");
		expect(args).toContain(reasoningModel.provider);
		expect(args.filter((arg) => arg === "--thinking")).toHaveLength(1);
		expect(args).toContain("high");
	});

	test("gives an actionable error when neither agent nor parent has a model", async () => {
		const result = await executeSingle(
			testAgents(),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			undefined,
			registry,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
		);

		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain('agent "thinking-test" has no configured model and no parent model');
		expect(result.errorMessage).toContain("pass a per-call model override");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("rejects non-off thinking for non-reasoning models before spawn", async () => {
		const result = await executeSingle(
			testAgents("test-provider/simple-model"),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"test-provider",
			registry,
			undefined,
			nonReasoningModel.id,
			undefined,
			undefined,
			undefined,
			"high",
		);

		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("non-reasoning model");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("rejects xhigh for reasoning models that do not support it", async () => {
		const result = await executeSingle(
			testAgents("test-provider/ordinary-reasoning-model"),
			"thinking-test",
			"do work",
			tempCwd,
			undefined,
			undefined,
			undefined,
			"test-provider",
			registry,
			undefined,
			nonXhighModel.id,
			undefined,
			undefined,
			undefined,
			"xhigh",
		);

		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("not supported");
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("parallel and chain inheritance", () => {
	function createTool(onComplete: (result: SubagentResult) => void) {
		return createSubagentToolDefinition(tempCwd, {
			parentProvider: () => "test-provider",
			parentModel: () => reasoningModel.id,
			modelRegistry: registry,
			onBackgroundComplete: (_agentId, result) => onComplete(result),
		});
	}

	test("parallel tasks use per-task thinking over the top-level value", async () => {
		mockSpawnResult("high");
		const completions: Array<ThinkingLevel | undefined> = [];
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const tool = createTool((result) => {
			completions.push(result.thinking);
			if (completions.length === 2) resolveDone();
		});

		await tool.execute(
			"parallel-call",
			{
				agent: "thinking-test",
				thinking: "low",
				tasks: [{ task: "inherits" }, { task: "overrides", thinking: "high" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await done;

		const thinkingArgs = vi.mocked(spawn).mock.calls.map((call) => {
			const index = call[1].indexOf("--thinking");
			return index === -1 ? undefined : call[1][index + 1];
		});
		expect(thinkingArgs.sort()).toEqual(["high", "low"]);
		expect(completions).toHaveLength(2);
	});

	test("background completion preserves child-effective thinking over the requested level", async () => {
		mockSpawnResult("low");
		let resolveDone!: (result: SubagentResult) => void;
		const done = new Promise<SubagentResult>((resolve) => {
			resolveDone = resolve;
		});
		const tool = createTool(resolveDone);

		await tool.execute(
			"background-effective",
			{ agent: "thinking-test", task: "work", thinking: "high" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const result = await done;

		const args = vi.mocked(spawn).mock.calls[0][1];
		expect(args).toContain("--thinking");
		expect(args).toContain("high");
		expect(result.thinking).toBe("low");
		expect(result.model).toBe("test-provider/gpt-5.6-test");
	});

	test("chain steps use per-step thinking and preserve structured completion metadata", async () => {
		mockSpawnResult(["low", "high"]);
		let resolveDone!: (result: SubagentResult) => void;
		const done = new Promise<SubagentResult>((resolve) => {
			resolveDone = resolve;
		});
		const tool = createTool(resolveDone);

		await tool.execute(
			"chain-call",
			{
				agent: "thinking-test",
				thinking: "low",
				chain: [{ task: "inherits" }, { task: "overrides {previous}", thinking: "high" }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const result = await done;

		const thinkingArgs = vi.mocked(spawn).mock.calls.map((call) => {
			const index = call[1].indexOf("--thinking");
			return index === -1 ? undefined : call[1][index + 1];
		});
		expect(thinkingArgs).toEqual(["low", "high"]);
		expect(result.model).toBeUndefined();
		expect(result.thinking).toBeUndefined();
		expect(result.steps).toEqual([
			{
				step: 1,
				agent: "thinking-test",
				success: true,
				model: "test-provider/gpt-5.6-test",
				thinking: "low",
			},
			{
				step: 2,
				agent: "thinking-test",
				success: true,
				model: "test-provider/gpt-5.6-test",
				thinking: "high",
			},
		]);
	});
});
