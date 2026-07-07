import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	type BackgroundAgentInfo,
	type ChildLineSinks,
	createSubagentToolDefinition,
	getBackgroundAgents,
	handleChildJsonlLine,
} from "../src/core/tools/subagent.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { toRpcBackgroundAgentInfo } from "../src/modes/rpc/rpc-mode.js";
import type { RpcBackgroundAgentInfo, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.js";

function makeSinks(overrides: Partial<ChildLineSinks> = {}): ChildLineSinks & {
	events: Record<string, unknown>[];
	messages: Array<{ role: string; content: any[] }>;
	plains: string[];
	models: string[];
	progress: string[];
} {
	const events: Record<string, unknown>[] = [];
	const messages: Array<{ role: string; content: any[] }> = [];
	const plains: string[] = [];
	const models: string[] = [];
	const progress: string[] = [];
	return {
		events,
		messages,
		plains,
		models,
		progress,
		onEvent: (e) => events.push(e),
		onAssistantMessage: (m) => messages.push(m),
		onProgress: (t) => progress.push(t),
		onModel: (m) => models.push(m),
		onPlainLine: (l) => plains.push(l),
		toolNameRef: { current: "" },
		...overrides,
	};
}

describe("handleChildJsonlLine — event relay", () => {
	it("relays every parsed JSONL event to onEvent, including the session header", () => {
		const sinks = makeSinks();
		handleChildJsonlLine(JSON.stringify({ type: "session", id: "abc", cwd: "/tmp" }), sinks);
		handleChildJsonlLine(JSON.stringify({ type: "agent_start", model: { id: "m1" } }), sinks);
		handleChildJsonlLine(JSON.stringify({ type: "message_update", partial: "tok" }), sinks);
		handleChildJsonlLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }), sinks);
		handleChildJsonlLine(JSON.stringify({ type: "agent_end" }), sinks);

		expect(sinks.events.map((e) => e.type)).toEqual([
			"session",
			"agent_start",
			"message_update",
			"tool_execution_start",
			"agent_end",
		]);
	});

	it("does not relay non-JSON lines — they go to onPlainLine", () => {
		const sinks = makeSinks();
		handleChildJsonlLine("Error: something broke before JSONL mode", sinks);
		expect(sinks.events).toHaveLength(0);
		expect(sinks.plains).toEqual(["Error: something broke before JSONL mode"]);
	});

	it("does not relay JSON values without a string type field", () => {
		const sinks = makeSinks();
		handleChildJsonlLine(JSON.stringify({ notype: true }), sinks);
		handleChildJsonlLine(JSON.stringify([1, 2, 3]), sinks);
		handleChildJsonlLine(JSON.stringify("bare string"), sinks);
		handleChildJsonlLine(JSON.stringify(null), sinks);
		expect(sinks.events).toHaveLength(0);
		// Non-object JSON values are preserved as plain lines for diagnostics
		expect(sinks.plains).toEqual(['"bare string"', "null"]);
	});

	it("keeps existing extraction behavior alongside the relay", () => {
		const sinks = makeSinks();
		handleChildJsonlLine(JSON.stringify({ type: "agent_start", model: { id: "claude-x" } }), sinks);
		handleChildJsonlLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
			sinks,
		);
		handleChildJsonlLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }), sinks);
		handleChildJsonlLine(JSON.stringify({ type: "tool_execution_end" }), sinks);

		expect(sinks.models).toEqual(["claude-x"]);
		expect(sinks.messages).toHaveLength(1);
		expect(sinks.progress).toEqual(["Using bash...", "bash done"]);
	});

	it("works without an onEvent sink (relay is opt-in)", () => {
		const sinks = makeSinks({ onEvent: undefined });
		expect(() => handleChildJsonlLine(JSON.stringify({ type: "agent_end" }), sinks)).not.toThrow();
	});

	it("ignores empty lines", () => {
		const sinks = makeSinks();
		handleChildJsonlLine("", sinks);
		handleChildJsonlLine("   ", sinks);
		expect(sinks.events).toHaveLength(0);
		expect(sinks.plains).toHaveLength(0);
	});
});

describe("background agent registry — session dir exposure", () => {
	const dummyCtx = {} as ExtensionContext;

	it("records sessionDir and cwd at launch and exposes them via getBackgroundAgents", async () => {
		const onBackgroundStart = vi.fn();
		const tool = createSubagentToolDefinition(process.cwd(), {
			onBackgroundStart,
			onBackgroundComplete: vi.fn(),
		});
		const result = await tool.execute(
			"call-reg-1",
			{ background: true, tasks: [{ task: "registry sessionDir probe", cwd: "/tmp" }] },
			undefined,
			undefined,
			dummyCtx,
		);
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("background agent");

		const launchedId = onBackgroundStart.mock.calls[0][0] as string;
		const mine = getBackgroundAgents().find((a) => a.agentId === launchedId);
		expect(mine).toBeDefined();
		expect(mine!.sessionDir).toBeTruthy();
		expect(mine!.sessionDir).toContain("subagent-sessions");
		expect(mine!.cwd).toBe("/tmp");
	});

	it("passes sessionDir to onBackgroundStart", async () => {
		const onBackgroundStart = vi.fn();
		const tool = createSubagentToolDefinition(process.cwd(), {
			onBackgroundStart,
			onBackgroundComplete: vi.fn(),
		});
		await tool.execute(
			"call-reg-2",
			{ background: true, tasks: [{ task: "start callback sessionDir probe" }] },
			undefined,
			undefined,
			dummyCtx,
		);
		expect(onBackgroundStart).toHaveBeenCalled();
		const [agentId, agentType, , sessionDir] = onBackgroundStart.mock.calls[0];
		expect(typeof agentId).toBe("string");
		expect(typeof agentType).toBe("string");
		expect(sessionDir).toContain("subagent-sessions");
	});
});

describe("toRpcBackgroundAgentInfo", () => {
	it("maps registry entries to the DTO, converting startedAt to ISO", () => {
		const info: BackgroundAgentInfo = {
			agentId: "a1b2c3",
			agentType: "Explore",
			taskSummary: "map the codebase",
			startedAt: new Date("2026-07-07T12:00:00.000Z").getTime(),
			status: "running",
			sessionDir: "/home/u/.dreb/agent/subagent-sessions/a1b2c3",
			cwd: "/home/u/project",
		};
		expect(toRpcBackgroundAgentInfo(info)).toEqual({
			agentId: "a1b2c3",
			agentType: "Explore",
			taskSummary: "map the codebase",
			startedAt: "2026-07-07T12:00:00.000Z",
			status: "running",
			sessionDir: "/home/u/.dreb/agent/subagent-sessions/a1b2c3",
			sessionFile: undefined,
			cwd: "/home/u/project",
		});
	});
});

describe("RpcClient.listBackgroundAgents", () => {
	it("sends list_background_agents and unwraps agents", async () => {
		const client = new RpcClient() as any;
		const agents: RpcBackgroundAgentInfo[] = [
			{
				agentId: "abc",
				agentType: "Explore",
				taskSummary: "t",
				startedAt: "2026-07-07T12:00:00.000Z",
				status: "completed",
				sessionFile: "/tmp/s.jsonl",
			},
		];
		client.send = vi.fn().mockResolvedValue({
			type: "response",
			command: "list_background_agents",
			success: true,
			data: { agents },
		});
		await expect(client.listBackgroundAgents()).resolves.toEqual(agents);
		expect(client.send).toHaveBeenCalledWith({ type: "list_background_agents" });
	});
});

describe("RpcClient.sendExtensionUIResponse", () => {
	it("writes the response as a JSONL line to the child's stdin", () => {
		const client = new RpcClient() as any;
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdin.on("data", (c) => chunks.push(c.toString()));
		client.process = { stdin };
		client._dead = false;

		const response: RpcExtensionUIResponse = { type: "extension_ui_response", id: "ui_1", confirmed: true };
		client.sendExtensionUIResponse(response);

		expect(chunks.join("")).toBe(`${JSON.stringify(response)}\n`);
	});

	it("throws loudly when the process is not running", () => {
		const client = new RpcClient() as any;
		client._dead = true;
		expect(() =>
			client.sendExtensionUIResponse({ type: "extension_ui_response", id: "ui_1", cancelled: true }),
		).toThrow(/not running/);
	});
});
