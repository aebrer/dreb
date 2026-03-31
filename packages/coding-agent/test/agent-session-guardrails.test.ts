/**
 * Tests for background agent guardrails in AgentSession:
 * - Layer B: Sentinel monitor (detects hallucinated bg agent output)
 * - Layer C: steer() vs followUp() delivery for bg agent results
 * - Layer D: Turn counter/limiter while bg agents are running
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dreb/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// Mock getRunningBackgroundAgents so we can simulate bg agents being active
const mockGetRunningBackgroundAgents = vi.fn().mockReturnValue([]);

vi.mock("../src/core/tools/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getRunningBackgroundAgents: (...args: unknown[]) => mockGetRunningBackgroundAgents(...args),
	};
});

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

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession background agent guardrails", () => {
	let session: AgentSession;
	let tempDir: string;
	let agent: Agent;

	// Track steer calls
	let steerCalls: Array<{ role: string; content: any[] }>;
	let _originalSteer: (msg: any) => void;

	// Track followUp calls
	let followUpCalls: Array<{ role: string; content: any[] }>;
	let _originalFollowUp: (msg: any) => void;

	// Control mock LLM responses
	let streamResponder: (stream: MockAssistantStream) => void;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-guardrails-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = findModel("anthropic", "sonnet")!;
		steerCalls = [];
		followUpCalls = [];

		// Reset mock to return no bg agents by default
		mockGetRunningBackgroundAgents.mockReturnValue([]);

		agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => streamResponder(stream));
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Intercept steer calls
		_originalSteer = agent.steer.bind(agent);
		agent.steer = (msg: any) => {
			steerCalls.push(msg);
			// Don't actually steer (would interfere with test flow)
		};

		// Intercept followUp calls
		_originalFollowUp = agent.followUp.bind(agent);
		agent.followUp = (msg: any) => {
			followUpCalls.push(msg);
		};
	});

	afterEach(() => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	describe("Layer B: Sentinel monitor", () => {
		it("should steer when model generates <background-agent-complete> while bg agents run", async () => {
			// Simulate a running background agent
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "test task", startedAt: Date.now(), status: "running" },
			]);

			// Set up a stream that emits text containing the sentinel
			streamResponder = (stream) => {
				const partial = createAssistantMessage(
					"<background-agent-complete>\nFake agent output\n</background-agent-complete>",
				);
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({
					type: "text_delta",
					delta: "<background-agent-complete>",
					partial,
				} as any);
				stream.push({ type: "done", reason: "stop", message: partial });
			};

			await session.prompt("test");

			// Sentinel should have fired — steer called with warning
			expect(steerCalls.length).toBe(1);
			const warning = steerCalls[0];
			expect(warning.content[0].text).toContain("fabricating a background agent response");
		});

		it("should not steer when no background agents are running", async () => {
			// No bg agents (default mock)
			mockGetRunningBackgroundAgents.mockReturnValue([]);

			streamResponder = (stream) => {
				const msg = createAssistantMessage("<background-agent-complete>fake</background-agent-complete>");
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({
					type: "text_delta",
					delta: "<background-agent-complete>",
					partial: msg,
				} as any);
				stream.push({ type: "done", reason: "stop", message: msg });
			};

			await session.prompt("test");

			// No bg agents running → sentinel should not fire
			expect(steerCalls.length).toBe(0);
		});

		it("should only steer once per streaming response (deduplication)", async () => {
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "test task", startedAt: Date.now(), status: "running" },
			]);

			streamResponder = (stream) => {
				const partial1 = createAssistantMessage("<background-agent-complete>");
				const partial2 = createAssistantMessage(
					"<background-agent-complete>\nMore fake output\n<background-agent-complete>",
				);
				stream.push({ type: "start", partial: createAssistantMessage("") });
				// Two text_delta events with sentinel
				stream.push({ type: "text_delta", delta: "<background-agent-complete>", partial: partial1 } as any);
				stream.push({
					type: "text_delta",
					delta: "\nMore fake output\n<background-agent-complete>",
					partial: partial2,
				} as any);
				stream.push({ type: "done", reason: "stop", message: partial2 });
			};

			await session.prompt("test");

			// Should only steer once despite multiple sentinel matches
			expect(steerCalls.length).toBe(1);
		});
	});

	describe("Layer D: Turn counter", () => {
		it("shouldContinue returns true when no background agents are running", () => {
			// With no bg agents, shouldContinue should allow unlimited turns
			let callCount = 0;
			streamResponder = (stream) => {
				callCount++;
				const msg = createAssistantMessage(`Response ${callCount}`);
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: msg });
			};

			return session.prompt("test").then(() => {
				// No turn limit warnings should have been queued
				const turnLimitWarnings = steerCalls.filter((c) =>
					c.content?.some?.((b: any) => b.text?.includes("Turn limit")),
				);
				expect(turnLimitWarnings.length).toBe(0);
			});
		});

		it("increments bgTurnCounter on turn_end while bg agents are running", async () => {
			// Simulate bg agents running
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "test task", startedAt: Date.now(), status: "running" },
			]);

			streamResponder = (stream) => {
				const msg = createAssistantMessage("Response");
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: msg });
			};

			await session.prompt("test");

			// After one prompt (one turn_end), counter should be 1
			const sessionAny = session as any;
			expect(sessionAny._bgTurnCounter).toBe(1);
		});

		it("resets bgTurnCounter to 0 when no bg agents are running", async () => {
			const sessionAny = session as any;

			// Artificially set counter high
			sessionAny._bgTurnCounter = 5;

			// No bg agents running
			mockGetRunningBackgroundAgents.mockReturnValue([]);

			streamResponder = (stream) => {
				const msg = createAssistantMessage("Response");
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: msg });
			};

			await session.prompt("test");

			// Counter should have been reset to 0 on turn_end when no bg agents
			expect(sessionAny._bgTurnCounter).toBe(0);
		});

		it("shouldContinue returns false when bgTurnCounter reaches BG_TURN_LIMIT", () => {
			const sessionAny = session as any;

			// Simulate bg agents running
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "test task", startedAt: Date.now(), status: "running" },
			]);

			// Set counter to the limit
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;

			// Access the shouldContinue callback directly via the agent
			const shouldContinue = (agent as any)._shouldContinue;
			expect(shouldContinue).toBeDefined();
			expect(shouldContinue()).toBe(false);
		});

		it("shouldContinue does not inject stale steer warnings", () => {
			const sessionAny = session as any;

			// Simulate bg agents running and counter at limit
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "test task", startedAt: Date.now(), status: "running" },
			]);
			sessionAny._bgTurnCounter = 3;

			// Call shouldContinue
			const shouldContinue = (agent as any)._shouldContinue;
			shouldContinue();

			// No steer messages should have been queued (the stale warning bug was fixed)
			expect(steerCalls.length).toBe(0);
		});

		it("bgTurnCounter resets on bg agent delivery via _handleBackgroundComplete", () => {
			const sessionAny = session as any;

			// Simulate bg agents having run — counter is elevated
			sessionAny._bgTurnCounter = 5;

			// Deliver a non-cancelled bg agent result
			sessionAny._handleBackgroundComplete(
				"bg-1",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "done",
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			// Counter should have been reset to 0 by the delivery
			expect(sessionAny._bgTurnCounter).toBe(0);
		});
	});

	describe("Layer C: steer vs followUp delivery", () => {
		it("uses steer() when agent is streaming during bg agent delivery", () => {
			// Simulate agent currently streaming
			Object.defineProperty(agent.state, "isStreaming", { value: true, configurable: true });

			const sessionAny = session as any;
			sessionAny._handleBackgroundComplete(
				"bg-1",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "result output",
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			// Should have used steer (not followUp or prompt)
			expect(steerCalls.length).toBe(1);
			expect(steerCalls[0].content[0].text).toContain("Background agent bg-1");
			expect(followUpCalls.length).toBe(0);

			// Clean up
			Object.defineProperty(agent.state, "isStreaming", { value: false, configurable: true });
		});

		it("uses prompt() when agent is not streaming during bg agent delivery", async () => {
			// isStreaming is false by default — parent is idle
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-2",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "result output",
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			// Should have used prompt (not steer or followUp)
			expect(promptSpy).toHaveBeenCalledTimes(1);
			const promptMsg = promptSpy.mock.calls[0][0] as any;
			expect(promptMsg.content[0].text).toContain("Background agent bg-2");
			expect(steerCalls.length).toBe(0);
			expect(followUpCalls.length).toBe(0);

			promptSpy.mockRestore();
		});

		it("does not trigger a response for cancelled bg agents", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt");
			const appendSpy = vi.spyOn(agent, "appendMessage");

			sessionAny._handleBackgroundComplete(
				"bg-1",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "cancelled output",
					stderr: "",
					errorMessage: null,
				},
				true,
			); // cancelled = true

			// Should have appended the message but NOT triggered steer/prompt
			expect(appendSpy).toHaveBeenCalledTimes(1);
			expect(steerCalls.length).toBe(0);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(followUpCalls.length).toBe(0);

			promptSpy.mockRestore();
			appendSpy.mockRestore();
		});

		it("does not reset bgTurnCounter for cancelled bg agents", () => {
			const sessionAny = session as any;
			sessionAny._bgTurnCounter = 3;

			sessionAny._handleBackgroundComplete(
				"bg-1",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "cancelled",
					stderr: "",
					errorMessage: null,
				},
				true,
			); // cancelled = true

			// Counter should NOT have been reset — cancellation doesn't mean work finished
			expect(sessionAny._bgTurnCounter).toBe(3);
		});
	});

	describe("Guardrail cleanup on dispose", () => {
		it("should clear shouldContinue on dispose", () => {
			// Before dispose, shouldContinue should be set
			expect((agent as any)._shouldContinue).toBeDefined();

			session.dispose();

			// After dispose, shouldContinue should be cleared
			expect((agent as any)._shouldContinue).toBeUndefined();
		});
	});
});
