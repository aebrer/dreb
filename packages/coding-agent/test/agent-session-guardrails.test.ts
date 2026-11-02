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

		it("increments bgTurnCounter on turn_end when bg agents were already running at turn_start", async () => {
			// Simulate bg agents running before the turn starts
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

		it("does not count the launch turn and pauses only after three post-launch parent turns", async () => {
			const sessionAny = session as any;
			const shouldContinue = (agent as any)._shouldContinue;

			// Launch turn starts with no bg agents, then bg agents become visible before turn_end.
			mockGetRunningBackgroundAgents.mockReturnValue([]);
			streamResponder = (stream) => {
				mockGetRunningBackgroundAgents.mockReturnValue([
					{
						agentId: "bg-1",
						agentType: "test",
						taskSummary: "test task",
						startedAt: Date.now(),
						status: "running",
					},
				]);
				const msg = createAssistantMessage("Launched bg agent");
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: msg });
			};

			await session.prompt("launch bg agent");
			expect(sessionAny._bgTurnCounter).toBe(0);
			expect(shouldContinue()).toBe(true);

			for (let turn = 1; turn <= 3; turn++) {
				streamResponder = (stream) => {
					const msg = createAssistantMessage(`Post-launch turn ${turn}`);
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: msg });
				};

				await session.prompt(`post-launch turn ${turn}`);
				expect(sessionAny._bgTurnCounter).toBe(turn);
				expect(shouldContinue()).toBe(turn < 3);
			}
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

		it("emits parent_paused_for_background_agents event when the guardrail halts", () => {
			const sessionAny = session as any;

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
				{ agentId: "bg-2", agentType: "test", taskSummary: "task b", startedAt: Date.now(), status: "running" },
			]);
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;

			const shouldContinue = (agent as any)._shouldContinue;
			expect(shouldContinue()).toBe(false);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents.length).toBe(1);
			expect(pauseEvents[0].runningAgentCount).toBe(2);
			expect(pauseEvents[0].turnsUsed).toBe(3);
			expect(pauseEvents[0].turnLimit).toBe(3);

			// The notification must be a frontend/session event, NOT a model steer
			expect(steerCalls.length).toBe(0);
		});

		it("emits the pause notification only once when shouldContinue is re-entered at the limit", () => {
			const sessionAny = session as any;

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
			]);
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;

			const shouldContinue = (agent as any)._shouldContinue;
			expect(shouldContinue()).toBe(false);
			expect(shouldContinue()).toBe(false);
			expect(shouldContinue()).toBe(false);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents).toHaveLength(1);
			expect(pauseEvents[0].turnsUsed).toBe(3);
			expect(steerCalls.length).toBe(0);
		});

		it("re-emits the pause notification for a new episode after a bg-delivery reset", () => {
			const sessionAny = session as any;

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
			]);

			const shouldContinue = (agent as any)._shouldContinue;

			// First pause episode — emit once, flag set.
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;
			expect(shouldContinue()).toBe(false);
			expect(sessionAny._bgPauseNotified).toBe(true);

			// A bg agent delivers results — counter AND the pause-notified flag must reset together.
			sessionAny._handleBackgroundComplete(
				"bg-1",
				{ agent: "test", task: "task a", exitCode: 0, output: "done", stderr: "", errorMessage: null },
				false,
			);
			expect(sessionAny._bgTurnCounter).toBe(0);
			expect(sessionAny._bgPauseNotified).toBe(false);

			// Second pause episode (a fresh batch climbs back to the limit) — must re-notify.
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;
			expect(shouldContinue()).toBe(false);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents).toHaveLength(2);
			expect(steerCalls.length).toBe(0);
		});

		it("re-arms the pause notification on a new run's turn_start so a re-pause re-notifies", async () => {
			const sessionAny = session as any;

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
			]);

			const shouldContinue = (agent as any)._shouldContinue;

			// First pause episode — emit once, flag set.
			sessionAny._bgTurnCounter = (AgentSession as any).BG_TURN_LIMIT ?? 3;
			expect(shouldContinue()).toBe(false);
			expect(sessionAny._bgPauseNotified).toBe(true);

			// User sends a message to continue. The ungated first turn runs; turn_start must
			// re-arm the notification (clear _bgPauseNotified) even though bg agents are still
			// running and the counter is still at the limit. Without the re-arm, the re-pause
			// would break the loop silently with no notification.
			streamResponder = (stream) => {
				const msg = createAssistantMessage("Acknowledged — continuing");
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: msg });
			};
			await session.prompt("please continue");

			// turn_start re-armed the flag; turn_end ticked the counter past the limit.
			expect(sessionAny._bgPauseNotified).toBe(false);
			expect(sessionAny._bgTurnCounter).toBeGreaterThanOrEqual((AgentSession as any).BG_TURN_LIMIT ?? 3);

			// The re-pause now re-notifies instead of breaking silently.
			expect(shouldContinue()).toBe(false);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents).toHaveLength(2);
			expect(steerCalls.length).toBe(0);
		});

		it("does not pause and emits no event when the guardrail is disabled", () => {
			const sessionAny = session as any;
			session.settingsManager.setBackgroundAgentGuardrailEnabled(false);

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
			]);
			// Counter well past the default limit
			sessionAny._bgTurnCounter = 99;

			const shouldContinue = (agent as any)._shouldContinue;
			expect(shouldContinue()).toBe(true);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents.length).toBe(0);
		});

		it("respects a custom parentTurnLimit", () => {
			const sessionAny = session as any;
			// parentTurnLimit is JSON-only (no setter); poke the merged settings view directly.
			(session.settingsManager as any).settings.backgroundAgents = { parentTurnLimit: 1 };

			const events: any[] = [];
			session.subscribe((e) => events.push(e));

			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-1", agentType: "test", taskSummary: "task a", startedAt: Date.now(), status: "running" },
			]);

			const shouldContinue = (agent as any)._shouldContinue;

			// Below the custom limit — keep going
			sessionAny._bgTurnCounter = 0;
			expect(shouldContinue()).toBe(true);

			// At the custom limit — pause and emit
			sessionAny._bgTurnCounter = 1;
			expect(shouldContinue()).toBe(false);

			const pauseEvents = events.filter((e) => e.type === "parent_paused_for_background_agents");
			expect(pauseEvents.length).toBe(1);
			expect(pauseEvents[0].turnLimit).toBe(1);
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

		it("surfaces errorMessage on a clean (exitCode 0) exit when the result was truncated", async () => {
			// A background subagent that truncated at the token limit exits cleanly
			// (JSON mode always exits 0) but carries an errorMessage. The delivered
			// message must include the error rather than treating it as a clean success.
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-trunc",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "partial answer that got cut off",
					stderr: "",
					errorMessage: "Response truncated at the configured output token limit after 3 attempts",
				},
				false,
			);

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const promptMsg = promptSpy.mock.calls[0][0] as any;
			const text = promptMsg.content[0].text as string;
			// Both the loud error and the preserved partial output must be present.
			expect(text).toContain("Error: Response truncated at the configured output token limit after 3 attempts");
			expect(text).toContain("partial answer that got cut off");

			promptSpy.mockRestore();
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

		/** Flatten a message's text parts for assertions. */
		function messageText(message: object): string {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
				.join("");
		}

		const cancelledResult = (output: string) => ({
			agent: "worker",
			task: "test task",
			exitCode: 0,
			output,
			stderr: "",
			errorMessage: null,
		});

		it("defers a cancellation notice that arrives mid-run until the parent run ends", async () => {
			const sessionAny = session as any;
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				void released.then(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("parent reply") }),
				);
			};
			const running = session.prompt("parent task");
			await vi.waitFor(() => expect(agent.state.isStreaming).toBe(true));

			sessionAny._handleBackgroundComplete("bg-stop-1", cancelledResult("first partial"), true);
			sessionAny._handleBackgroundComplete("bg-stop-2", cancelledResult("second partial"), true);

			// Mid-run: nothing appended to context or the session log, nothing queued as a turn.
			const stateTexts = () => agent.state.messages.map(messageText);
			expect(stateTexts().some((text) => text.includes("bg-stop-1"))).toBe(false);
			expect(steerCalls.length).toBe(0);
			expect(followUpCalls.length).toBe(0);

			release();
			await running;
			await vi.waitFor(() => expect(stateTexts().some((text) => text.includes("bg-stop-2"))).toBe(true));

			// Appended after the run's assistant reply, in arrival order, and persisted the same way.
			const texts = stateTexts();
			const replyIndex = texts.findIndex((text) => text.includes("parent reply"));
			const firstIndex = texts.findIndex((text) => text.includes("bg-stop-1"));
			const secondIndex = texts.findIndex((text) => text.includes("bg-stop-2"));
			expect(replyIndex).toBeGreaterThan(-1);
			expect(firstIndex).toBeGreaterThan(replyIndex);
			expect(secondIndex).toBe(firstIndex + 1);
			expect(texts[firstIndex]).toContain("cancelled by the user");

			const persisted = session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => messageText((entry as { message: { content?: unknown } }).message));
			const persistedReply = persisted.findIndex((text) => text.includes("parent reply"));
			expect(persisted.findIndex((text) => text.includes("bg-stop-1"))).toBeGreaterThan(persistedReply);

			// Never triggered a response.
			expect(steerCalls.length).toBe(0);
			expect(followUpCalls.length).toBe(0);
			expect(agent.state.isStreaming).toBe(false);
		});

		it("flushes deferred cancellation notices before a background completion prompts the parent", () => {
			const sessionAny = session as any;
			const appendSpy = vi.spyOn(agent, "appendMessage");
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			Object.defineProperty(agent.state, "isStreaming", { value: true, configurable: true });
			sessionAny._handleBackgroundComplete("bg-cancel", cancelledResult("partial"), true);
			expect(appendSpy).not.toHaveBeenCalled();

			Object.defineProperty(agent.state, "isStreaming", { value: false, configurable: true });
			sessionAny._handleBackgroundComplete("bg-done", cancelledResult("finished"), false);

			expect(appendSpy).toHaveBeenCalledTimes(1);
			expect(messageText(appendSpy.mock.calls[0][0] as { content?: unknown })).toContain("bg-cancel");
			expect(promptSpy).toHaveBeenCalledTimes(1);
			expect(appendSpy.mock.invocationCallOrder[0]).toBeLessThan(promptSpy.mock.invocationCallOrder[0]);

			appendSpy.mockRestore();
			promptSpy.mockRestore();
		});

		it("emits background_agent_end with cancelled: true and success: false for a user stop", () => {
			const sessionAny = session as any;
			const events: Array<Record<string, unknown>> = [];
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "background_agent_end") events.push(event as unknown as Record<string, unknown>);
			});
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			// A gracefully stopped child exits 0, but the stop must still read as cancelled.
			sessionAny._handleBackgroundComplete("bg-stopped", cancelledResult("partial"), true);
			sessionAny._handleBackgroundComplete("bg-finished", cancelledResult("done"), false);

			expect(events).toMatchObject([
				{ agentId: "bg-stopped", cancelled: true, success: false },
				{ agentId: "bg-finished", cancelled: false, success: true },
			]);
			unsubscribe();
			promptSpy.mockRestore();
		});

		/** Persisted message texts of the current session, in log order. */
		function persistedTexts(): string[] {
			return session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => messageText((entry as { message: { content?: unknown } }).message));
		}

		const stateTexts = () => agent.state.messages.map(messageText);

		/** Force the agent's streaming flag without running a turn. */
		function setStreaming(value: boolean): void {
			Object.defineProperty(agent.state, "isStreaming", { value, configurable: true });
		}

		/** Start a parent run whose reply is held until `release()`, and wait until it streams. */
		async function startHeldRun(reply = "parent reply") {
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				void released.then(() =>
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage(reply) }),
				);
			};
			const running = session.prompt("parent task");
			await vi.waitFor(() => expect(agent.state.isStreaming).toBe(true));
			return { running, release };
		}

		/** Make `agent.abort()` also finish the held mock stream (the mock ignores the abort signal). */
		function releaseOnAbort(release: () => void): void {
			const originalAbort = agent.abort.bind(agent);
			vi.spyOn(agent, "abort").mockImplementation(() => {
				originalAbort();
				release();
			});
		}

		it("persists a notice after run events that are still being processed when it arrives", async () => {
			const sessionAny = session as any;
			// A slow extension message_end handler keeps the reply unpersisted after the agent
			// has already emitted agent_end (isStreaming is false at that point).
			let releaseHandler!: () => void;
			const handlerReleased = new Promise<void>((resolve) => {
				releaseHandler = resolve;
			});
			const originalEmit = sessionAny._emitExtensionEvent.bind(sessionAny);
			sessionAny._emitExtensionEvent = async (event: { type: string; message?: { role?: string } }) => {
				if (event.type === "message_end" && event.message?.role === "assistant") await handlerReleased;
				await originalEmit(event);
			};
			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("parent reply") });
			};
			const running = session.prompt("parent task");
			await vi.waitFor(() => expect(stateTexts().some((text) => text.includes("parent reply"))).toBe(true));
			await vi.waitFor(() => expect(agent.state.isStreaming).toBe(false));
			expect(persistedTexts().some((text) => text.includes("parent reply"))).toBe(false);

			sessionAny._handleBackgroundComplete("bg-race", cancelledResult("partial"), true);
			expect(stateTexts().some((text) => text.includes("bg-race"))).toBe(false);
			expect(persistedTexts().some((text) => text.includes("bg-race"))).toBe(false);

			releaseHandler();
			await running;
			await vi.waitFor(() => expect(persistedTexts().some((text) => text.includes("bg-race"))).toBe(true));

			const persisted = persistedTexts();
			expect(persisted.findIndex((text) => text.includes("bg-race"))).toBeGreaterThan(
				persisted.findIndex((text) => text.includes("parent reply")),
			);
			const state = stateTexts();
			expect(state.findIndex((text) => text.includes("bg-race"))).toBeGreaterThan(
				state.findIndex((text) => text.includes("parent reply")),
			);
		});

		it("holds a notice that arrives during an auto-retry backoff until the retried run ends", async () => {
			const sessionAny = session as any;
			session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 30 } });
			let calls = 0;
			streamResponder = (stream) => {
				calls++;
				if (calls === 1) {
					const failed = createAssistantMessage("", "error");
					failed.errorMessage = "overloaded_error";
					stream.push({ type: "start", partial: failed });
					stream.push({ type: "error", reason: "error", error: failed });
					return;
				}
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("retried reply") });
			};
			let deliveredDuringBackoff = false;
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "auto_retry_start" || deliveredDuringBackoff) return;
				deliveredDuringBackoff = true;
				sessionAny._handleBackgroundComplete("bg-retry", cancelledResult("partial"), true);
				// The run is not streaming during the backoff, but the notice must wait for the retry.
				expect(agent.state.isStreaming).toBe(false);
				expect(stateTexts().some((text) => text.includes("bg-retry"))).toBe(false);
				expect(persistedTexts().some((text) => text.includes("bg-retry"))).toBe(false);
			});

			await session.prompt("parent task");
			await vi.waitFor(() => expect(stateTexts().some((text) => text.includes("bg-retry"))).toBe(true));
			unsubscribe();

			expect(deliveredDuringBackoff).toBe(true);
			expect(calls).toBe(2);
			const state = stateTexts();
			expect(state.findIndex((text) => text.includes("bg-retry"))).toBeGreaterThan(
				state.findIndex((text) => text.includes("retried reply")),
			);
			const persisted = persistedTexts();
			expect(persisted.findIndex((text) => text.includes("bg-retry"))).toBeGreaterThan(
				persisted.findIndex((text) => text.includes("retried reply")),
			);
			expect(steerCalls.length).toBe(0);
			expect(followUpCalls.length).toBe(0);
		});

		it("holds a notice that arrives while the run's agent_end is compacting, then appends it after", async () => {
			const sessionAny = session as any;
			let releaseCompaction!: () => void;
			const compactionReleased = new Promise<void>((resolve) => {
				releaseCompaction = resolve;
			});
			let compactionStarted = false;
			vi.spyOn(sessionAny, "_checkCompaction").mockImplementation(async () => {
				compactionStarted = true;
				await compactionReleased;
			});
			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("parent reply") });
			};
			const running = session.prompt("parent task");
			await vi.waitFor(() => expect(compactionStarted).toBe(true));
			expect(agent.state.isStreaming).toBe(false);

			sessionAny._handleBackgroundComplete("bg-compact", cancelledResult("partial"), true);
			expect(stateTexts().some((text) => text.includes("bg-compact"))).toBe(false);
			expect(persistedTexts().some((text) => text.includes("bg-compact"))).toBe(false);

			releaseCompaction();
			await running;
			await vi.waitFor(() => expect(persistedTexts().some((text) => text.includes("bg-compact"))).toBe(true));
			expect(stateTexts().at(-1)).toContain("bg-compact");
		});

		it("flushes a deferred notice before a later user prompt", async () => {
			const sessionAny = session as any;
			setStreaming(true);
			sessionAny._handleBackgroundComplete("bg-before-prompt", cancelledResult("partial"), true);
			expect(stateTexts().some((text) => text.includes("bg-before-prompt"))).toBe(false);
			// The run ended without its agent_end delivering the notice (e.g. an abandoned retry).
			setStreaming(false);
			expect(stateTexts().some((text) => text.includes("bg-before-prompt"))).toBe(false);

			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("next reply") });
			};
			await session.prompt("next question");

			const state = stateTexts();
			const noticeIndex = state.findIndex((text) => text.includes("bg-before-prompt"));
			expect(noticeIndex).toBeGreaterThan(-1);
			expect(noticeIndex).toBeLessThan(state.findIndex((text) => text.includes("next question")));
			const persisted = persistedTexts();
			expect(persisted.findIndex((text) => text.includes("bg-before-prompt"))).toBeLessThan(
				persisted.findIndex((text) => text.includes("next question")),
			);
		});

		it("delivers a deferred notice on an agent_end that carries no assistant message", async () => {
			const sessionAny = session as any;
			setStreaming(true);
			sessionAny._handleBackgroundComplete("bg-bare-end", cancelledResult("partial"), true);
			setStreaming(false);
			expect(stateTexts().some((text) => text.includes("bg-bare-end"))).toBe(false);

			sessionAny._handleAgentEvent({ type: "agent_end", messages: [] });
			await sessionAny._agentEventQueue;

			expect(stateTexts().at(-1)).toContain("bg-bare-end");
			expect(persistedTexts().at(-1)).toContain("bg-bare-end");
		});

		it("persists a deferred notice to the outgoing session, after its queued events, before a new session replaces it", async () => {
			const sessionAny = session as any;
			// The run has ended, but a slow extension handler still holds its reply unpersisted.
			let releaseReplyEnd!: () => void;
			const replyEndReleased = new Promise<void>((resolve) => {
				releaseReplyEnd = resolve;
			});
			const originalEmit = sessionAny._emitExtensionEvent.bind(sessionAny);
			sessionAny._emitExtensionEvent = async (event: { type: string; message?: { role?: string } }) => {
				if (event.type === "message_end" && event.message?.role === "assistant") await replyEndReleased;
				await originalEmit(event);
			};
			const appendSpy = vi.spyOn(session.sessionManager, "appendMessage");
			const newSessionSpy = vi.spyOn(session.sessionManager, "newSession");
			streamResponder = (stream) => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("parent reply") });
			};
			const running = session.prompt("parent task");
			await vi.waitFor(() => expect(stateTexts().some((text) => text.includes("parent reply"))).toBe(true));
			await vi.waitFor(() => expect(agent.state.isStreaming).toBe(false));
			sessionAny._handleBackgroundComplete("bg-new-session", cancelledResult("partial"), true);
			expect(persistedTexts().some((text) => text.includes("bg-new-session"))).toBe(false);

			const switching = session.newSession();
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Still waiting for the outgoing session's queued events to be persisted.
			expect(newSessionSpy).not.toHaveBeenCalled();
			releaseReplyEnd();
			await switching;
			await running;

			const calls = appendSpy.mock.calls.map(([message]) => messageText(message));
			const replyCall = calls.findIndex((text) => text.includes("parent reply"));
			const noticeCall = calls.findIndex((text) => text.includes("bg-new-session"));
			expect(replyCall).toBeGreaterThan(-1);
			expect(noticeCall).toBeGreaterThan(replyCall);
			expect(appendSpy.mock.invocationCallOrder[noticeCall]).toBeLessThan(newSessionSpy.mock.invocationCallOrder[0]);
			// Nothing is left to leak into the new session.
			expect(sessionAny._pendingCancellationNotices).toEqual([]);
			expect(persistedTexts().some((text) => text.includes("bg-new-session"))).toBe(false);
		});

		it("persists a deferred notice to the outgoing session before switching sessions", async () => {
			const sessionAny = session as any;
			const { running, release } = await startHeldRun();
			releaseOnAbort(release);
			sessionAny._handleBackgroundComplete("bg-switch", cancelledResult("partial"), true);

			const appendSpy = vi.spyOn(session.sessionManager, "appendMessage");
			const setSessionFileSpy = vi.spyOn(session.sessionManager, "setSessionFile").mockImplementation(() => {});
			await session.switchSession(join(tempDir, "other-session.jsonl"));
			await running;

			const noticeCall = appendSpy.mock.calls.findIndex(([message]) => messageText(message).includes("bg-switch"));
			expect(noticeCall).toBeGreaterThan(-1);
			expect(appendSpy.mock.invocationCallOrder[noticeCall]).toBeLessThan(
				setSessionFileSpy.mock.invocationCallOrder[0],
			);
			expect(sessionAny._pendingCancellationNotices).toEqual([]);
		});

		it("persists a deferred notice to the outgoing session's log only when forking mid-run", async () => {
			const sessionAny = session as any;
			const { running, release } = await startHeldRun();
			sessionAny._handleBackgroundComplete("bg-fork", cancelledResult("partial"), true);
			const firstUser = session.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			expect(firstUser).toBeDefined();

			const appendSpy = vi.spyOn(session.sessionManager, "appendMessage");
			const stateAppendSpy = vi.spyOn(agent, "appendMessage");
			const branchSpy = vi.spyOn(session.sessionManager, "newSession");
			await session.fork(firstUser!.id);

			const noticeCall = appendSpy.mock.calls.findIndex(([message]) => messageText(message).includes("bg-fork"));
			expect(noticeCall).toBeGreaterThan(-1);
			expect(appendSpy.mock.invocationCallOrder[noticeCall]).toBeLessThan(branchSpy.mock.invocationCallOrder[0]);
			// The run is still going: the live context never gets the notice mid-run.
			expect(stateAppendSpy.mock.calls.some(([message]) => messageText(message).includes("bg-fork"))).toBe(false);
			expect(sessionAny._pendingCancellationNotices).toEqual([]);

			release();
			await running;
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

		it("includes session log path in completion message when sessionFile is set", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-session",
				{
					agent: "test",
					task: "test task",
					exitCode: 0,
					output: "done",
					stderr: "",
					errorMessage: null,
					sessionFile: "/tmp/test-session.jsonl",
				},
				false,
			);

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const promptMsg = promptSpy.mock.calls[0][0] as any;
			expect(promptMsg.content[0].text).toContain("Session log: /tmp/test-session.jsonl");

			promptSpy.mockRestore();
		});

		it("includes effective model and thinking in delivery and completion events", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);
			const events: any[] = [];
			session.subscribe((event) => events.push(event));

			sessionAny._handleBackgroundComplete(
				"bg-metadata",
				{
					agent: "test",
					task: "test task",
					model: "resolved-model",
					thinking: "high",
					exitCode: 0,
					output: "done",
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			const promptMsg = promptSpy.mock.calls[0][0] as any;
			expect(promptMsg.content[0].text).toContain("Execution metadata: model: resolved-model, thinking: high");
			expect(events.find((event) => event.type === "background_agent_end")).toMatchObject({
				agentId: "bg-metadata",
				model: "resolved-model",
				thinking: "high",
			});

			promptSpy.mockRestore();
		});

		it("includes structured chain-step metadata in completion events", () => {
			const sessionAny = session as any;
			vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);
			const events: any[] = [];
			session.subscribe((event) => events.push(event));
			const steps = [
				{
					step: 1,
					agent: "Explore",
					success: true,
					model: "anthropic/claude-sonnet",
					thinking: "low",
				},
				{
					step: 2,
					agent: "feature-dev",
					success: true,
					model: "openai/gpt-5.6-sol",
					thinking: "high",
				},
			];

			sessionAny._handleBackgroundComplete(
				"bg-chain-metadata",
				{
					agent: "Explore",
					task: "2-step chain",
					steps,
					exitCode: 0,
					output: "done",
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			expect(events.find((event) => event.type === "background_agent_end")).toMatchObject({
				agentId: "bg-chain-metadata",
				steps,
			});
		});

		it("omits session log from completion message when sessionFile is not set", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-no-session",
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

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const promptMsg = promptSpy.mock.calls[0][0] as any;
			expect(promptMsg.content[0].text).not.toContain("Session log:");

			promptSpy.mockRestore();
		});

		it("does not include error message when agent is cancelled by user (even with exitCode !== 0)", () => {
			const sessionAny = session as any;
			const appendSpy = vi.spyOn(agent, "appendMessage");

			sessionAny._handleBackgroundComplete(
				"bg-aborted",
				{
					agent: "test",
					task: "test task",
					exitCode: 1,
					output: "",
					stderr: "Warning: Unknown tool search.",
					errorMessage: "Warning: Unknown tool search.",
				},
				true, // cancelled = true (user pressed ESC)
			);

			expect(appendSpy).toHaveBeenCalledTimes(1);
			const msg = appendSpy.mock.calls[0][0] as any;
			const text = msg.content[0].text;
			expect(text).toContain("cancelled by the user");
			expect(text).not.toContain("Error:");
			expect(text).not.toContain("Unknown tool search");

			appendSpy.mockRestore();
		});

		it("still shows error message for non-cancelled agents that fail", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-failed",
				{
					agent: "test",
					task: "test task",
					exitCode: 1,
					output: "",
					stderr: "some real error",
					errorMessage: "some real error",
				},
				false, // NOT cancelled — genuine failure
			);

			expect(promptSpy).toHaveBeenCalledTimes(1);
			const promptMsg = promptSpy.mock.calls[0][0] as any;
			const text = promptMsg.content[0].text;
			expect(text).toContain("Error: some real error");
			expect(text).not.toContain("cancelled by the user");

			promptSpy.mockRestore();
		});

		it("delimits a completed agent's output from the system lines around it", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);
			mockGetRunningBackgroundAgents.mockReturnValue([
				{ agentId: "bg-other", agentType: "Explore", taskSummary: "still going" },
			]);

			sessionAny._handleBackgroundComplete(
				"bg-layout-done",
				{
					agent: "test",
					task: "test task",
					model: "resolved-model",
					thinking: "high",
					exitCode: 0,
					output: "Final answer.",
					stderr: "",
					errorMessage: null,
					sessionFile: "/tmp/child.jsonl",
				},
				false,
			);

			const text = (promptSpy.mock.calls[0][0] as any).content[0].text;
			expect(text).toBe(
				"<background-agent-complete>\n" +
					"Background agent bg-layout-done (test) completed.\n\n" +
					"Execution metadata: model: resolved-model, thinking: high\n\n" +
					"--- agent output ---\n\n" +
					"Final answer.\n\n" +
					"--- end of agent output ---\n\n" +
					"Session log: /tmp/child.jsonl\n\n" +
					"Still running (1):\n  bg-other (Explore): still going\n" +
					"</background-agent-complete>",
			);

			promptSpy.mockRestore();
		});

		it("marks a cancelled agent's output partial, after the cancellation line", () => {
			const sessionAny = session as any;
			const appendSpy = vi.spyOn(agent, "appendMessage");

			sessionAny._handleBackgroundComplete(
				"bg-layout-cancelled",
				{
					agent: "test",
					task: "test task",
					model: "resolved-model",
					thinking: "high",
					exitCode: 0,
					output: "I'll start by surveying the filesystem layout and mounts.",
					stderr: "",
					errorMessage: null,
				},
				true,
			);

			const text = (appendSpy.mock.calls[0][0] as any).content[0].text;
			expect(text).toContain(
				"Execution metadata: model: resolved-model, thinking: high\n\n" +
					"This agent was cancelled by the user.\n\n" +
					"--- agent output (partial) ---\n\n" +
					"I'll start by surveying the filesystem layout and mounts.\n\n" +
					"--- end of agent output ---\n" +
					"</background-agent-complete>",
			);

			appendSpy.mockRestore();
		});

		it("marks a failed agent's output partial and keeps the error and routing notes outside it", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);

			sessionAny._handleBackgroundComplete(
				"bg-layout-failed",
				{
					agent: "test",
					task: "test task",
					exitCode: 1,
					output: "Got halfway.",
					notes: ["[WARNING: model selection ignored]", "[MODEL FALLBACK: skipped 1]\n- a: down"],
					stderr: "boom",
					errorMessage: "boom",
				},
				false,
			);

			const text = (promptSpy.mock.calls[0][0] as any).content[0].text;
			expect(text).toContain(
				"Error: boom\n\n" +
					"[WARNING: model selection ignored]\n\n" +
					"[MODEL FALLBACK: skipped 1]\n- a: down\n\n" +
					"--- agent output (partial) ---\n\n" +
					"Got halfway.\n\n" +
					"--- end of agent output ---",
			);

			promptSpy.mockRestore();
		});

		it("does not wrap a chain's per-step report in another output block", () => {
			const sessionAny = session as any;
			const promptSpy = vi.spyOn(agent, "prompt").mockResolvedValue(undefined as any);
			const chainReport =
				"### Step 1\n## Agent: Explore\n\n--- agent output ---\n\nfound it\n\n--- end of agent output ---";

			sessionAny._handleBackgroundComplete(
				"bg-layout-chain",
				{
					agent: "Explore",
					task: "1-step chain",
					steps: [{ step: 1, agent: "Explore", success: true }],
					exitCode: 0,
					output: chainReport,
					stderr: "",
					errorMessage: null,
				},
				false,
			);

			const text = (promptSpy.mock.calls[0][0] as any).content[0].text;
			expect(text).toContain(`completed.\n\n${chainReport}\n</background-agent-complete>`);
			expect(text.match(/--- agent output/g)).toHaveLength(1);

			promptSpy.mockRestore();
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
