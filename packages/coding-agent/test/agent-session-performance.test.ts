import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dreb/agent-core";
import type { AssistantMessageEvent } from "@dreb/ai";
import { type AssistantMessage, EventStream, findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PerformanceTracker } from "../src/core/performance-tracker.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: any): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

describe("AgentSession performance tracking", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-perf-session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(overrides?: {
		stopReason?: "stop" | "error" | "aborted";
		outputTokens?: number;
		durationMs?: number;
		omitDurationMs?: boolean;
	}) {
		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				setTimeout(() => {
					const msg = createAssistantMessage("Hello", {
						stopReason: overrides?.stopReason ?? "stop",
						usage: {
							input: 0,
							output: overrides?.outputTokens ?? 10,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: overrides?.outputTokens ?? 10,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						...(overrides?.omitDurationMs ? {} : { durationMs: overrides?.durationMs ?? 1000 }),
					});
					stream.push({ type: "start", partial: msg });
					if (overrides?.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						stream.push({
							type: "done",
							reason: (overrides?.stopReason ?? "stop") as "length" | "stop" | "toolUse",
							message: msg,
						});
					}
				}, 15);
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const performanceTracker = new PerformanceTracker(join(tempDir, "performance.jsonl"));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			performanceTracker,
		});

		return { session, sessionManager };
	}

	it("records performance on successful assistant response", async () => {
		const { session } = createSession();
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await session.prompt("Test");
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(1);

		const logContent = readFileSync(join(tempDir, "performance.jsonl"), "utf8");
		const lines = logContent.trim().split("\n");
		const lastEntry = JSON.parse(lines[lines.length - 1]);
		expect(lastEntry.tps).toBe((lastEntry.outputTokens * 1000) / lastEntry.durationMs);
	});

	it("does not record performance when stopReason is error", async () => {
		const { session } = createSession({ stopReason: "error" });
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await session.prompt("Test");
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});

	it("does not record performance when stopReason is aborted", async () => {
		const { session } = createSession({ stopReason: "aborted" });
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await session.prompt("Test");
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});

	it("does not record performance when output tokens are 0", async () => {
		const { session } = createSession({ outputTokens: 0 });
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await session.prompt("Test");
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});

	it("does not record performance when durationMs is 0", async () => {
		const { session } = createSession();
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await (session as any)._processAgentEvent({
			type: "message_end",
			message: createAssistantMessage("Hello", { durationMs: 0 }),
		});
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});

	it("does not record performance when durationMs is missing", async () => {
		const { session } = createSession();
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await (session as any)._processAgentEvent({
			type: "message_end",
			message: createAssistantMessage("Hello"),
		});
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});

	it("does not record performance for implausibly tiny durations", async () => {
		const { session } = createSession();
		const before = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;
		await (session as any)._processAgentEvent({
			type: "message_end",
			message: createAssistantMessage("Hello", { durationMs: 0.1 }),
		});
		const after = session.getPerformanceTracker().getRollingAverage("anthropic", "mock").count;

		expect(after - before).toBe(0);
	});
});
