import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult, SubagentToolInput } from "../src/core/tools/subagent.js";
import {
	abortBackgroundAgents,
	createSubagentToolDefinition,
	getBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
	steerBackgroundAgent,
} from "../src/core/tools/subagent.js";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

type FakeChild = ReturnType<typeof spawn> & {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	commands: Array<Record<string, unknown>>;
	failSteering?: boolean;
	finish: () => void;
};

let cwd: string;
let children: FakeChild[];
let completed: (agentId: string, result: SubagentResult, cancelled: boolean) => void;
let parentId: string;
const model = {
	provider: "test",
	id: "worker",
	name: "Worker",
	api: "openai-responses",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

function makeChild(): FakeChild {
	const proc = new EventEmitter() as FakeChild;
	proc.stdin = new PassThrough();
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.commands = [];
	let closed = false;
	proc.finish = () => {
		if (closed) return;
		closed = true;
		proc.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
		process.nextTick(() => proc.emit("close", 0));
	};
	proc.kill = vi.fn(() => {
		if (!closed) {
			closed = true;
			process.nextTick(() => proc.emit("close", 1));
		}
		return true;
	}) as typeof proc.kill;
	let buffer = "";
	proc.stdin.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const cmd = JSON.parse(line) as Record<string, unknown>;
			proc.commands.push(cmd);
			setImmediate(() =>
				proc.stdout.write(
					`${JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: !(cmd.type === "steer" && proc.failSteering), error: proc.failSteering ? "Child refused steering." : undefined })}\n`,
				),
			);
		}
	});
	children.push(proc);
	return proc;
}

function tool(owner = parentId, options: Record<string, unknown> = {}) {
	return createSubagentToolDefinition(cwd, {
		parentSessionId: () => owner,
		parentProvider: () => "test",
		parentModel: () => "worker",
		modelRegistry: {
			getAll: () => [model],
			find: (provider: string, id: string) => (provider === "test" && id === "worker" ? model : undefined),
			getApiKey: async () => "key",
			getModelPromptSettings: () => undefined,
			authStorage: { hasAuth: () => true },
		} as never,
		onBackgroundComplete: completed,
		...options,
	});
}

async function run(t: ReturnType<typeof tool>, input: SubagentToolInput) {
	return t.execute("call", input, new AbortController().signal, () => {}, undefined as never);
}
function text(result: Awaited<ReturnType<typeof run>>) {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}
function launchedId(result: Awaited<ReturnType<typeof run>>) {
	const id = text(result).match(/\b[0-9a-f]{12}\b/)?.[0];
	if (!id) throw new Error(`No child ID: ${text(result)}`);
	return id;
}
async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "dreb-steer-"));
	mkdirSync(join(cwd, ".dreb", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".dreb", "agents", "steer-test.md"),
		"---\nname: steer-test\nmodel: test/worker\n---\nTest worker\n",
	);
	children = [];
	completed = vi.fn();
	parentId = `parent-${Math.random()}`;
	vi.mocked(spawn).mockImplementation(() => makeChild());
});
afterEach(() => {
	abortBackgroundAgents();
	vi.mocked(spawn).mockReset();
	rmSync(cwd, { recursive: true, force: true });
});

describe("parent subagent steering", () => {
	it("queues exact text for the selected single/parallel child and continues the parent turn", async () => {
		const t = tool();
		const single = launchedId(await run(t, { agent: "steer-test", task: "first" }));
		const parallel = await run(t, {
			tasks: [
				{ agent: "steer-test", task: "second" },
				{ agent: "steer-test", task: "third" },
			],
		});
		const ids = text(parallel).match(/\b[0-9a-f]{12}\b/g) ?? [];
		expect(ids).toHaveLength(2);
		await flush();
		const before = vi.mocked(spawn).mock.calls.length;
		const result = await run(t, { steer: { agentId: ids[1], message: "  exact\ntext  " } });
		expect(text(result)).toContain(`Message queued for background agent ${ids[1]}`);
		expect(result.endTurn).not.toBe(true);
		expect(result.details).toEqual({ mode: "steer", agentCount: 0 });
		expect(vi.mocked(spawn).mock.calls).toHaveLength(before);
		expect(children[2].commands.filter((cmd) => cmd.type === "steer")).toEqual([
			expect.objectContaining({ message: "  exact\ntext  " }),
		]);
		expect(children[0].commands.some((cmd) => cmd.type === "steer")).toBe(false);
		expect(children[1].commands.some((cmd) => cmd.type === "steer")).toBe(false);
		expect(single).not.toBe(ids[1]);
	});

	it("targets only the active chain step and fails between steps", async () => {
		let nextStep!: () => void;
		const chain = tool(parentId, {
			arbitrate: async () => {
				if (children.length === 1)
					await new Promise<void>((resolve) => {
						nextStep = resolve;
					});
				return { enabled: false };
			},
		});
		const id = launchedId(
			await run(chain, {
				chain: [
					{ agent: "steer-test", task: "one" },
					{ agent: "steer-test", task: "two" },
				],
			}),
		);
		await flush();
		expect(text(await run(chain, { steer: { agentId: id, message: "step one" } }))).toContain("Message queued");
		children[0].finish();
		await flush();
		expect(text(await run(chain, { steer: { agentId: id, message: "gap" } }))).toContain(
			"has not started a controllable child yet",
		);
		nextStep();
		await flush();
		expect(text(await run(chain, { steer: { agentId: id, message: "step two" } }))).toContain("Message queued");
		expect(children[1].commands.filter((cmd) => cmd.type === "steer")).toEqual([
			expect.objectContaining({ message: "step two" }),
		]);
	});

	it("rejects invalid modes, blank fields, unknown IDs, queued and completed children", async () => {
		const t = tool();
		const id = launchedId(await run(t, { agent: "steer-test", task: "running" }));
		await flush();
		for (const invalid of [
			{ steer: { agentId: id, message: "x" }, task: "new task" },
			{ steer: { agentId: id, message: "x" }, tasks: [{ task: "new task" }] },
			{ steer: { agentId: id, message: "x" }, chain: [{ task: "new task" }] },
			{ steer: { agentId: id, message: " " } },
			{ steer: { agentId: "", message: "x" } },
			{ steer: { agentId: id, message: "x" }, model: "test/worker" },
		] as SubagentToolInput[])
			expect(text(await run(t, invalid))).toMatch(/^Error:/);
		expect(text(await run(t, { steer: { agentId: "missing", message: "x" } }))).toContain(
			"not launched by this parent",
		);
		expect(children[0].commands.filter((cmd) => cmd.type === "steer")).toHaveLength(0);
		children[0].finish();
		await flush();
		expect(text(await run(t, { steer: { agentId: id, message: "late" } }))).toContain("no longer running");

		let release!: () => void;
		const queued = tool(parentId, {
			concurrencyGate: {
				acquire: () =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
				release: vi.fn(),
			},
		});
		const queuedId = launchedId(await run(queued, { agent: "steer-test", task: "queued" }));
		expect(text(await run(queued, { steer: { agentId: queuedId, message: "early" } }))).toContain(
			"has not started a controllable child yet",
		);
		release();
	});

	it("enforces session ownership even after tool rebuild, without restricting Dashboard control", async () => {
		const owner = tool("session-A");
		const id = launchedId(await run(owner, { agent: "steer-test", task: "private" }));
		await flush();
		const foreign = tool("session-B");
		expect(text(await run(foreign, { steer: { agentId: id, message: "wrong" } }))).toContain(
			"not launched by this parent",
		);
		const reloaded = tool("session-A");
		expect(text(await run(reloaded, { steer: { agentId: id, message: "right" } }))).toContain("Message queued");
		// The existing human-facing RPC/Dashboard path remains process-wide.
		await steerBackgroundAgent(id, "dashboard text");
		expect(children[0].commands.filter((cmd) => cmd.type === "steer")).toEqual([
			expect.objectContaining({ message: "right" }),
			expect.objectContaining({ message: "dashboard text" }),
		]);
	});

	it("reports a child control rejection instead of claiming delivery", async () => {
		const t = tool();
		const id = launchedId(await run(t, { agent: "steer-test", task: "work" }));
		await flush();
		children[0].failSteering = true;
		const result = await run(t, { steer: { agentId: id, message: "new instruction" } });
		expect(text(result)).toContain("Child refused steering.");
		expect(text(result)).not.toContain("Message queued");
	});

	it("rejects rehydrated child IDs and renders the steering operation", async () => {
		const sessionDir = join(cwd, "subagent-sessions", "old-child");
		mkdirSync(sessionDir, { recursive: true });
		const parentFile = join(cwd, "parent.jsonl");
		writeFileSync(
			join(sessionDir, "child.jsonl"),
			`${JSON.stringify({ type: "session", parentSession: parentFile, timestamp: new Date().toISOString() })}\n`,
		);
		expect(rehydrateBackgroundAgentsFromDisk(parentFile, join(cwd, "subagent-sessions"))).toBe(1);
		const id = getBackgroundAgents().find((entry) => entry.agentId.startsWith("rehydrated-old-child"))?.agentId;
		expect(id).toBeTruthy();
		const t = tool();
		expect(text(await run(t, { steer: { agentId: id!, message: "too late" } }))).toContain(
			"not launched by this parent",
		);
		const plainTheme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
		const view = t.renderCall?.(
			{ steer: { agentId: "abc123", message: "secret" } },
			plainTheme as never,
			{ argsComplete: true } as never,
		);
		expect(view?.render(100).join(" ")).toContain("steer abc123");
		expect(view?.render(100).join(" ")).not.toContain("secret");
	});
});
