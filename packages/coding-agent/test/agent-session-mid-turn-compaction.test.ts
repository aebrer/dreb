import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@dreb/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	findModel,
	type Message,
	type Model,
} from "@dreb/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { compact } from "../src/core/compaction/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/core/compaction/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/compaction/index.js")>();
	return {
		...actual,
		compact: vi.fn(async (preparation) => ({
			summary: "compacted mid-turn",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		})),
	};
});

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => {
			const reason =
				message.stopReason === "toolUse" || message.stopReason === "length" ? message.stopReason : "stop";
			this.push({ type: "done", reason, message });
		});
	}
}

function createAssistant(
	model: Model<any>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	totalTokens: number,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function textOf(message: Message): string {
	if (message.role === "assistant") {
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}
	if (message.role === "user" || message.role === "toolResult") {
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}
	return "";
}

describe("AgentSession mid-turn compaction", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-mid-turn-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.mocked(compact).mockClear();
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function runToolLoop(options: { compactionEnabled?: boolean; cancelCompaction?: boolean } = {}) {
		const baseModel = findModel("anthropic", "sonnet")!;
		const model = { ...baseModel, contextWindow: 20_000 };
		const requestContexts: Message[][] = [];
		const requestModels: string[] = [];
		let callIndex = 0;
		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [] },
			convertToLlm,
			streamFn: (requestModel, context) => {
				requestModels.push(requestModel.id);
				requestContexts.push(context.messages);
				const message =
					callIndex++ === 0
						? createAssistant(
								model,
								[
									{ type: "toolCall", id: "tool-1", name: "large", arguments: { id: 1 } },
									{ type: "toolCall", id: "tool-2", name: "large", arguments: { id: 2 } },
								],
								"toolUse",
								3500,
							)
						: createAssistant(model, [{ type: "text", text: "done" }], "stop", 100);
				return new MockAssistantStream(message);
			},
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		if (options.compactionEnabled === false) settingsManager.setCompactionEnabled(false);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		if (options.cancelCompaction) {
			const extensionRunner = {
				hasHandlers: vi.fn((event: string) => event === "session_before_compact"),
				emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
				emit: vi.fn().mockResolvedValue({ cancel: true }),
			};
			(session as unknown as { _extensionRunner: typeof extensionRunner })._extensionRunner = extensionRunner;
		}

		const schema = Type.Object({ id: Type.Number() });
		const tool: AgentTool<typeof schema> = {
			name: "large",
			label: "Large",
			description: "Return a large result",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `${params.id}:${"x".repeat(1000)}` }],
					details: {},
				};
			},
		};
		agent.setTools([tool]);
		const continueSpy = vi.spyOn(agent, "continue").mockResolvedValue();
		const events: Array<{ type: string; willRetry?: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "auto_compaction_start") events.push({ type: event.type });
			if (event.type === "auto_compaction_end") {
				events.push({ type: event.type, willRetry: event.willRetry });
			}
		});

		await session.prompt("start");
		await new Promise((resolve) => setTimeout(resolve, 120));
		return { agent, continueSpy, events, requestContexts, requestModels, sessionManager };
	}

	it("compacts after all tool results and continues in the same loop", async () => {
		const result = await runToolLoop();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(result.continueSpy).not.toHaveBeenCalled();
		expect(result.requestContexts).toHaveLength(2);
		expect(result.events).toEqual([
			{ type: "auto_compaction_start" },
			{ type: "auto_compaction_end", willRetry: true },
		]);

		const secondRequest = result.requestContexts[1];
		expect(secondRequest.some((message) => textOf(message).includes("compacted mid-turn"))).toBe(true);
		const toolCallIds = secondRequest.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
				: [],
		);
		const toolResultIds = secondRequest.flatMap((message) =>
			message.role === "toolResult" ? [message.toolCallId] : [],
		);
		expect(toolCallIds).toEqual(["tool-1", "tool-2"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(result.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("does not compact mid-turn when automatic compaction is disabled", async () => {
		const result = await runToolLoop({ compactionEnabled: false });

		expect(compact).not.toHaveBeenCalled();
		expect(result.continueSpy).not.toHaveBeenCalled();
		expect(result.events).toEqual([]);
		expect(result.requestContexts).toHaveLength(2);
		expect(result.requestContexts[1].some((message) => textOf(message).includes("compacted mid-turn"))).toBe(false);
	});

	it("continues with intact tool context when mid-turn compaction is cancelled", async () => {
		const result = await runToolLoop({ cancelCompaction: true });

		expect(compact).not.toHaveBeenCalled();
		expect(result.continueSpy).not.toHaveBeenCalled();
		expect(result.events).toEqual([
			{ type: "auto_compaction_start" },
			{ type: "auto_compaction_end", willRetry: false },
		]);
		const secondRequest = result.requestContexts[1];
		expect(secondRequest.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(secondRequest.some((message) => textOf(message).includes("compacted mid-turn"))).toBe(false);
	});
});
