/**
 * Single-agent cancellation of background subagents (issue 537): a user stop
 * cancels exactly one agent — executing, queued for a concurrency slot, or mid
 * chain — gracefully, reports it as cancelled, and leaves siblings untouched.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Model } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { log } from "../src/core/logger.js";
import {
	abortBackgroundAgent,
	abortBackgroundAgents,
	createSubagentToolDefinition,
	type executeSingle,
	getBackgroundAgents,
	getRunningBackgroundAgents,
	type SubagentResult,
	steerBackgroundAgent,
} from "../src/core/tools/subagent.js";

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

const registry = {
	getAll: () => [workerModel],
	find: (provider: string, id: string) =>
		provider === workerModel.provider && id === workerModel.id ? workerModel : undefined,
	getApiKey: vi.fn().mockResolvedValue("test-key"),
	getModelPromptSettings: () => undefined,
	authStorage: { hasAuth: () => true },
} as unknown as Parameters<typeof executeSingle>[8];

/** A live RPC-controlled child: acks commands, ends its run on `abort`, closes on any signal. */
interface FakeChild {
	commands: Array<Record<string, unknown>>;
	proc: ReturnType<typeof spawn> & { kill: ReturnType<typeof vi.fn> };
	/** Finish the run normally with the given output. */
	finish(output?: string): void;
}

let children: FakeChild[];
let tempCwd: string;

function mockLiveChildren(): void {
	vi.mocked(spawn).mockImplementation((() => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const commands: Array<Record<string, unknown>> = [];
		const proc = new EventEmitter() as FakeChild["proc"] & {
			stdin: PassThrough;
			stdout: PassThrough;
			stderr: PassThrough;
			killed: boolean;
			exitCode: number | null;
			signalCode: NodeJS.Signals | null;
		};
		proc.stdin = stdin;
		proc.stdout = stdout;
		proc.stderr = stderr;
		proc.killed = false;
		proc.exitCode = null;
		proc.signalCode = null;
		let closed = false;
		proc.kill = vi.fn((signal?: NodeJS.Signals) => {
			proc.killed = true;
			if (!closed) {
				closed = true;
				proc.signalCode = signal ?? "SIGTERM";
				process.nextTick(() => proc.emit("close", null));
			}
			return true;
		});
		const write = (event: Record<string, unknown>) => stdout.write(`${JSON.stringify(event)}\n`);
		let buffered = "";
		stdin.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				const command = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				buffered = buffered.slice(newline + 1);
				commands.push(command);
				process.nextTick(() => {
					if (command.type === "abort") {
						write({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "partial" }],
								stopReason: "aborted",
							},
						});
						write({ type: "agent_end" });
					}
					write({ type: "response", id: command.id, command: command.type, success: true, data: {} });
				});
				newline = buffered.indexOf("\n");
			}
		});
		children.push({
			commands,
			proc,
			finish(output = "done") {
				write({ type: "agent_start", model: { provider: "provider", id: "worker" } });
				write({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" },
				});
				write({ type: "agent_end" });
			},
		});
		return proc;
	}) as unknown as typeof spawn);
}

type Completion = { result: SubagentResult; cancelled: boolean };

/** Create the tool with completion/start tracking keyed by agentId and task label. */
function createTool(maxConcurrentSubagents = 4) {
	const completions = new Map<string, Completion>();
	const waiters = new Map<string, (completion: Completion) => void>();
	const idsByLabel = new Map<string, string>();
	const tool = createSubagentToolDefinition(tempCwd, {
		parentProvider: () => "provider",
		parentModel: () => "worker",
		modelRegistry: registry,
		maxConcurrentSubagents,
		onBackgroundStart: (agentId, _agentType, taskSummary) => idsByLabel.set(taskSummary, agentId),
		onBackgroundComplete: (agentId, result, cancelled) => {
			const completion = { result, cancelled };
			completions.set(agentId, completion);
			waiters.get(agentId)?.(completion);
		},
	});
	const completion = (agentId: string): Promise<Completion> => {
		const done = completions.get(agentId);
		if (done) return Promise.resolve(done);
		return new Promise((resolve) => waiters.set(agentId, resolve));
	};
	const execute = (params: Record<string, unknown>) =>
		tool.execute("call", params as never, new AbortController().signal, () => {}, undefined as never);
	return { execute, completion, idsByLabel, completions };
}

function statusOf(agentId: string): string | undefined {
	return getBackgroundAgents().find((agent) => agent.agentId === agentId)?.status;
}

async function waitForPrompts(count: number): Promise<void> {
	await vi.waitFor(() => {
		expect(children.length).toBe(count);
		for (const child of children) expect(child.commands[0]).toMatchObject({ type: "prompt" });
	});
}

beforeEach(() => {
	tempCwd = mkdtempSync(join(tmpdir(), "dreb-subagent-abort-"));
	const agentDir = join(tempCwd, ".dreb", "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "worker.md"),
		"---\nname: worker\ndescription: worker\ntools: read\nmodel: provider/worker\n---\nWorker prompt\n",
	);
	children = [];
	vi.mocked(spawn).mockReset();
	mockLiveChildren();
	vi.spyOn(log, "debug").mockImplementation(() => {});
	vi.spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(() => {
	abortBackgroundAgents();
	rmSync(tempCwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("abortBackgroundAgent (single-agent stop)", () => {
	test("cancels only the selected agent; a sibling keeps running with its control channel", async () => {
		const { execute, completion, idsByLabel } = createTool();
		await execute({
			tasks: [
				{ agent: "worker", task: "first" },
				{ agent: "worker", task: "second" },
			],
		});
		await waitForPrompts(2);
		const target = idsByLabel.get("worker task 1/2")!;
		const sibling = idsByLabel.get("worker task 2/2")!;

		abortBackgroundAgent(target);

		// Status flips synchronously so running-agent views never list a stopped agent.
		expect(statusOf(target)).toBe("cancelled");
		expect(getRunningBackgroundAgents().map((agent) => agent.agentId)).toEqual([sibling]);

		const stopped = await completion(target);
		expect(stopped.cancelled).toBe(true);
		// The child ended gracefully (agent_end → exit 0) yet is still reported as cancelled.
		expect(stopped.result).toMatchObject({ exitCode: 0, output: "partial" });
		expect(statusOf(target)).toBe("cancelled");
		expect(children[0].commands.map((command) => command.type)).toContain("abort");

		// The sibling was not touched and is still steerable.
		expect(children[1].commands.map((command) => command.type)).not.toContain("abort");
		expect(children[1].proc.kill).not.toHaveBeenCalled();
		expect(statusOf(sibling)).toBe("running");
		await steerBackgroundAgent(sibling, "keep going");
		expect(children[1].commands.at(-1)).toMatchObject({ type: "steer", message: "keep going" });

		children[1].finish("sibling result");
		const finished = await completion(sibling);
		expect(finished.cancelled).toBe(false);
		expect(statusOf(sibling)).toBe("completed");
	});

	test("fails loudly for unknown and no-longer-running agents", async () => {
		const { execute, completion, idsByLabel } = createTool();
		expect(() => abortBackgroundAgent("does-not-exist")).toThrow(/Unknown background agent/);

		await execute({ agent: "worker", task: "short" });
		await waitForPrompts(1);
		const agentId = idsByLabel.get("worker task")!;
		children[0].finish();
		await completion(agentId);

		expect(statusOf(agentId)).toBe("completed");
		expect(() => abortBackgroundAgent(agentId)).toThrow(/no longer running/);

		// A second stop of an already-cancelled agent is also rejected, not a silent no-op.
		await execute({ agent: "worker", task: "again" });
		await waitForPrompts(2);
		const second = [...idsByLabel.values()].at(-1)!;
		abortBackgroundAgent(second);
		expect(() => abortBackgroundAgent(second)).toThrow(/no longer running/);
		await completion(second);
	});

	test("a queued agent cancels immediately without consuming a concurrency slot", async () => {
		const { execute, completion, idsByLabel } = createTool(1);
		await execute({
			tasks: [
				{ agent: "worker", task: "running" },
				{ agent: "worker", task: "queued and stopped" },
				{ agent: "worker", task: "queued and kept" },
			],
		});
		await waitForPrompts(1);
		const running = idsByLabel.get("worker task 1/3")!;
		const stoppedWhileQueued = idsByLabel.get("worker task 2/3")!;
		const kept = idsByLabel.get("worker task 3/3")!;

		abortBackgroundAgent(stoppedWhileQueued);
		const stopped = await completion(stoppedWhileQueued);
		expect(stopped.cancelled).toBe(true);
		expect(statusOf(stoppedWhileQueued)).toBe("cancelled");
		// Settled without waiting for the slot and without ever spawning.
		expect(children).toHaveLength(1);
		expect(statusOf(running)).toBe("running");

		// The freed slot goes to the next real waiter — accounting is intact.
		children[0].finish();
		await completion(running);
		await waitForPrompts(2);
		children[1].finish("kept result");
		const keptCompletion = await completion(kept);
		expect(keptCompletion).toMatchObject({ cancelled: false, result: { output: "kept result" } });
		expect(children).toHaveLength(2);
	});

	test("stopping a chain ends it at the current step", async () => {
		const { execute, completion } = createTool();
		const launch = await execute({
			chain: [
				{ agent: "worker", task: "step one" },
				{ agent: "worker", task: "step two using {previous}" },
			],
		});
		await waitForPrompts(1);
		const chainId = /Background chain (\S+) started/.exec(
			(launch.content[0] as { type: "text"; text: string }).text,
		)?.[1];
		expect(chainId).toBeDefined();

		abortBackgroundAgent(chainId!);
		const stopped = await completion(chainId!);

		expect(stopped.cancelled).toBe(true);
		expect(statusOf(chainId!)).toBe("cancelled");
		expect(children).toHaveLength(1);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test("abortBackgroundAgents cancels every running agent and marks them cancelled", async () => {
		const { execute, completion, idsByLabel } = createTool();
		await execute({
			tasks: [
				{ agent: "worker", task: "a" },
				{ agent: "worker", task: "b" },
			],
		});
		await waitForPrompts(2);
		const ids = [idsByLabel.get("worker task 1/2")!, idsByLabel.get("worker task 2/2")!];

		abortBackgroundAgents();

		for (const id of ids) expect(statusOf(id)).toBe("cancelled");
		const results = await Promise.all(ids.map((id) => completion(id)));
		expect(results.map((result) => result.cancelled)).toEqual([true, true]);
		for (const id of ids) expect(statusOf(id)).toBe("cancelled");
		// Graceful: each child was asked to abort its own run before being terminated.
		for (const child of children) expect(child.commands.map((command) => command.type)).toContain("abort");
	});
});
