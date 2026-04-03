/**
 * Tests for sendPrompt, drainOutbox, and ensureSubscribed in message.ts.
 *
 * sendPrompt is the only export; drainOutbox and ensureSubscribed are
 * exercised indirectly through sendPrompt's behavior and side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available in vi.mock factories
// ---------------------------------------------------------------------------

const { mockSetUserSession, mockCleanupUploads, mockSafeSend, mockSendLong, mockSafeDelete, mockLog } = vi.hoisted(
	() => ({
		mockSetUserSession: vi.fn(),
		mockCleanupUploads: vi.fn(),
		mockSafeSend: vi.fn().mockResolvedValue(1),
		mockSendLong: vi.fn().mockResolvedValue(""),
		mockSafeDelete: vi.fn().mockResolvedValue(true),
		mockLog: vi.fn(),
	}),
);

vi.mock("../src/state.js", () => ({
	setUserSession: mockSetUserSession,
}));

vi.mock("../src/util/files.js", () => ({
	cleanupUploads: mockCleanupUploads,
	extractSendFiles: vi.fn().mockReturnValue({ text: "", files: [] }),
}));

vi.mock("../src/util/telegram.js", () => ({
	safeSend: mockSafeSend,
	sendLong: mockSendLong,
	safeDelete: mockSafeDelete,
	log: mockLog,
	DebouncedEditor: vi.fn().mockImplementation(() => ({
		edit: vi.fn().mockResolvedValue(undefined),
		flush: vi.fn().mockResolvedValue(undefined),
		cancel: vi.fn(),
	})),
}));

// Mock events.ts — createEventDisplay and handleAgentEvent
vi.mock("../src/handlers/events.js", () => ({
	createEventDisplay: vi.fn((_api: any, chatId: number, replyToId: number, statusMessageId: number | null) => ({
		chatId,
		replyToId,
		statusMessageId,
		toolsSinceText: [],
		toolCount: 0,
		textBlocks: [],
		tasks: [],
		backgroundAgents: new Map(),
		done: false,
		editor: {
			edit: vi.fn().mockResolvedValue(undefined),
			flush: vi.fn().mockResolvedValue(undefined),
			cancel: vi.fn(),
		},
		retryInProgress: false,
		pendingRetry: false,
		retryAttempt: 0,
	})),
	handleAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

import { sendPrompt } from "../src/handlers/message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApi() {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
		editMessageText: vi.fn().mockResolvedValue(true),
		deleteMessage: vi.fn().mockResolvedValue(true),
	} as any;
}

function createUserState(overrides?: Partial<UserState>): UserState {
	return {
		bridge: null,
		promptInFlight: false,
		newSessionFlag: false,
		newSessionCwd: null,
		effectiveCwd: null,
		backgroundAgents: new Map(),
		stopRequested: false,
		outbox: [],
		...overrides,
	};
}

/** Capture the onEvent callback from a bridge mock */
function createBridge(overrides?: Record<string, any>) {
	let eventCallback: ((event: any) => void) | null = null;
	const bridge = {
		isAlive: true,
		isStreaming: false,
		sessionFile: "test-session",
		onEvent: vi.fn((cb: (event: any) => void) => {
			eventCallback = cb;
			return () => {};
		}),
		prompt: vi.fn().mockResolvedValue(undefined),
		steer: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		refreshSessionInfo: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	return {
		bridge,
		fireEvent: (event: any) => {
			if (!eventCallback) throw new Error("No event callback registered");
			eventCallback(event);
		},
		get hasCallback() {
			return eventCallback !== null;
		},
	};
}

function defaultOpts(overrides?: Record<string, any>) {
	return {
		chatId: 100,
		replyToId: 200,
		userId: 42,
		prompt: "hello",
		statusMessageId: 999,
		...overrides,
	};
}

/** Wait for microtasks + a small delay to settle async chains */
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset safeSend to default success behavior
		mockSafeSend.mockResolvedValue(1);
		mockSendLong.mockResolvedValue("");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// 1. No bridge
	// -----------------------------------------------------------------------
	describe("no bridge", () => {
		it("sends error message and deletes status message", () => {
			const api = createApi();
			const userState = createUserState();
			const opts = defaultOpts();

			sendPrompt(api, userState, opts);

			expect(mockSafeDelete).toHaveBeenCalledWith(api, 100, 999);
			expect(mockSafeSend).toHaveBeenCalledWith(api, 100, "❌ No agent connection. Try sending your message again.");
			expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("No bridge"));
		});

		it("skips delete when no status message", () => {
			const api = createApi();
			const userState = createUserState();
			const opts = defaultOpts({ statusMessageId: null });

			sendPrompt(api, userState, opts);

			expect(mockSafeDelete).not.toHaveBeenCalled();
			expect(mockSafeSend).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// 2-3. Steering path
	// -----------------------------------------------------------------------
	describe("steering path", () => {
		it("calls steer() when bridge.isStreaming is true", async () => {
			const api = createApi();
			const { bridge } = createBridge({ isStreaming: true });
			const userState = createUserState({ bridge: bridge as any });
			const opts = defaultOpts();

			sendPrompt(api, userState, opts);
			await settle();

			expect(bridge.steer).toHaveBeenCalledWith("hello", undefined);
			expect(bridge.prompt).not.toHaveBeenCalled();
			expect(mockSafeDelete).toHaveBeenCalledWith(api, 100, 999);
			expect(mockSafeSend).toHaveBeenCalledWith(api, 100, expect.stringContaining("Steering"));
		});

		it("calls steer() when promptInFlight is true (race window)", async () => {
			const api = createApi();
			const { bridge } = createBridge({ isStreaming: false });
			const userState = createUserState({ bridge: bridge as any });

			// First call subscribes the bridge and fires prompt (normal path)
			sendPrompt(api, userState, defaultOpts({ prompt: "first" }));
			// promptInFlight is now true from the normal path
			expect(userState.promptInFlight).toBe(true);

			// Second call should detect promptInFlight and steer instead
			sendPrompt(api, userState, defaultOpts({ prompt: "second" }));
			await settle();

			expect(bridge.steer).toHaveBeenCalledWith("second", undefined);
			// prompt should have been called only once (from the first call)
			expect(bridge.prompt).toHaveBeenCalledTimes(1);
		});

		it("sends steering confirmation with truncated prompt", async () => {
			const api = createApi();
			const { bridge } = createBridge({ isStreaming: true });
			const userState = createUserState({ bridge: bridge as any });
			const longPrompt = "x".repeat(300);
			const opts = defaultOpts({ prompt: longPrompt });

			sendPrompt(api, userState, opts);
			await settle();

			const sentText = mockSafeSend.mock.calls.find((c: any[]) => c[2].includes("Steering"))?.[2];
			expect(sentText).toBeDefined();
			expect(sentText.length).toBeLessThan(longPrompt.length + 50);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Normal path
	// -----------------------------------------------------------------------
	describe("normal path", () => {
		it("sets promptInFlight and calls bridge.prompt()", async () => {
			const api = createApi();
			const { bridge } = createBridge();
			const userState = createUserState({ bridge: bridge as any });
			const opts = defaultOpts();

			sendPrompt(api, userState, opts);

			// promptInFlight set synchronously before prompt() resolves
			// (ensureSubscribed resets it, then normal path sets it again)
			expect(bridge.prompt).toHaveBeenCalledWith("hello", undefined);
		});

		it("passes images to bridge.prompt()", async () => {
			const api = createApi();
			const { bridge } = createBridge();
			const userState = createUserState({ bridge: bridge as any });
			const images = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
			const opts = defaultOpts({ images });

			sendPrompt(api, userState, opts);

			expect(bridge.prompt).toHaveBeenCalledWith("hello", images);
		});

		it("clears stopRequested on normal path", () => {
			const api = createApi();
			const { bridge } = createBridge();
			const userState = createUserState({ bridge: bridge as any, stopRequested: true });

			sendPrompt(api, userState, defaultOpts());

			expect(userState.stopRequested).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Normal path prompt error
	// -----------------------------------------------------------------------
	describe("normal path prompt error", () => {
		it("sends error and clears promptInFlight on prompt rejection", async () => {
			const api = createApi();
			const { bridge } = createBridge({
				prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
			});
			const userState = createUserState({ bridge: bridge as any });

			sendPrompt(api, userState, defaultOpts());
			await settle();

			expect(mockSafeSend).toHaveBeenCalledWith(api, 100, expect.stringContaining("connection refused"));
			expect(userState.promptInFlight).toBe(false);
			expect(mockCleanupUploads).toHaveBeenCalled();
		});

		it("suppresses error message when stopRequested", async () => {
			const api = createApi();
			const { bridge } = createBridge({
				prompt: vi.fn().mockRejectedValue(new Error("connection refused")),
			});
			const userState = createUserState({ bridge: bridge as any });

			sendPrompt(api, userState, defaultOpts());
			// Set stopRequested before the rejection settles
			userState.stopRequested = true;
			await settle();

			// safeSend should NOT have been called with an error message
			const errorCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2]?.includes("❌"));
			expect(errorCalls).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// 6. stopRequested suppresses steering error
	// -----------------------------------------------------------------------
	describe("stopRequested suppresses steering error", () => {
		it("does not send error when steer() fails and stopRequested is true", async () => {
			const api = createApi();
			const { bridge } = createBridge({
				isStreaming: true,
				steer: vi.fn().mockRejectedValue(new Error("steer failed")),
			});
			const userState = createUserState({ bridge: bridge as any });

			sendPrompt(api, userState, defaultOpts());
			// stopRequested is cleared by sendPrompt, set it after the call
			userState.stopRequested = true;
			await settle();

			const errorCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2]?.includes("❌"));
			expect(errorCalls).toHaveLength(0);
		});

		it("sends error when steer() fails and stopRequested is false", async () => {
			const api = createApi();
			const { bridge } = createBridge({
				isStreaming: true,
				steer: vi.fn().mockRejectedValue(new Error("steer failed")),
			});
			const userState = createUserState({ bridge: bridge as any });

			sendPrompt(api, userState, defaultOpts());
			await settle();

			expect(mockSafeSend).toHaveBeenCalledWith(api, 100, expect.stringContaining("Steering error"));
		});
	});
});

// ---------------------------------------------------------------------------
// drainOutbox (tested via outbox manipulation and event-driven delivery)
// ---------------------------------------------------------------------------

describe("drainOutbox", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSafeSend.mockResolvedValue(1);
		mockSendLong.mockResolvedValue("");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delivers messages in order", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		// Normal prompt to set up subscription and display
		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		// Pre-fill the outbox. These items sit at the front of the queue.
		// When agent_end fires, the DONE marker's enqueueSend kicks drainOutbox,
		// which drains these first, then the DONE marker.
		userState.outbox.push(
			{ chatId: 100, text: "first" },
			{ chatId: 100, text: "second" },
			{ chatId: 100, text: "third" },
		);

		// Fire agent_end — triggers enqueueSend for DONE marker, starting drain
		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		const textCalls = mockSafeSend.mock.calls.filter((c: any[]) => ["first", "second", "third"].includes(c[2]));
		expect(textCalls).toHaveLength(3);
		expect(textCalls[0][2]).toBe("first");
		expect(textCalls[1][2]).toBe("second");
		expect(textCalls[2][2]).toBe("third");
	});

	it("retries on failure then succeeds", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		// Fail twice, then succeed
		let callCount = 0;
		mockSafeSend.mockImplementation(async () => {
			callCount++;
			if (callCount <= 2) return 0; // failure
			return 1; // success
		});

		// Pre-fill outbox, then trigger drain via agent_end
		userState.outbox.push({ chatId: 100, text: "retry-me" });
		fireEvent({ type: "agent_end", messages: [] });

		// Wait for retries (RETRY_DELAY is 2000ms)
		await settle(6000);

		// Should have been called at least 3 times (2 failures + 1 success)
		const retryCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2] === "retry-me");
		expect(retryCalls.length).toBeGreaterThanOrEqual(3);
		// Outbox should be empty after successful delivery
		expect(userState.outbox).toHaveLength(0);
	}, 10_000);

	it("gives up after MAX_RETRIES (5)", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		// Fail only the target message; let the DONE marker succeed
		mockSafeSend.mockImplementation(async (_api: any, _chatId: number, text: string) => {
			if (text === "doomed") return 0;
			return 1;
		});

		// Pre-fill outbox, then trigger drain via agent_end
		userState.outbox.push({ chatId: 100, text: "doomed" });
		fireEvent({ type: "agent_end", messages: [] });

		// Wait for all retries (5 * 2s delay = 10s)
		await settle(12_000);

		// "doomed" should be dropped, outbox should be empty (DONE marker succeeds)
		expect(userState.outbox).toHaveLength(0);
		// Log should mention giving up
		expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Giving up"));
	}, 15_000);

	it("handles sendLong partial retry — updates item.text to remaining", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		// First sendLong call returns partial remaining, second call succeeds
		let longCallCount = 0;
		mockSendLong.mockImplementation(async () => {
			longCallCount++;
			if (longCallCount === 1) return "remaining text"; // partial failure
			return ""; // success
		});

		// Pre-fill outbox with a long message, then trigger drain via agent_end
		userState.outbox.push({ chatId: 100, text: "full long text", long: true });
		fireEvent({ type: "agent_end", messages: [] });

		await settle(5000);

		// sendLong should have been called at least twice
		expect(mockSendLong.mock.calls.length).toBeGreaterThanOrEqual(2);
		// Second call should have been with the remaining text
		expect(mockSendLong.mock.calls[1][2]).toBe("remaining text");
		// Outbox should be empty
		expect(userState.outbox).toHaveLength(0);
	}, 10_000);
});

// ---------------------------------------------------------------------------
// ensureSubscribed (tested through sendPrompt side effects)
// ---------------------------------------------------------------------------

describe("ensureSubscribed", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSafeSend.mockResolvedValue(1);
		mockSendLong.mockResolvedValue("");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers onEvent only once per bridge", () => {
		const api = createApi();
		const { bridge } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		sendPrompt(api, userState, defaultOpts());
		sendPrompt(api, userState, defaultOpts());

		expect(bridge.onEvent).toHaveBeenCalledTimes(1);
	});

	it("registers onEvent again for a new bridge", () => {
		const api = createApi();
		const { bridge: bridge1 } = createBridge();
		const { bridge: bridge2 } = createBridge();
		const userState = createUserState({ bridge: bridge1 as any });

		sendPrompt(api, userState, defaultOpts());
		expect(bridge1.onEvent).toHaveBeenCalledTimes(1);

		userState.bridge = bridge2 as any;
		sendPrompt(api, userState, defaultOpts());
		expect(bridge2.onEvent).toHaveBeenCalledTimes(1);
	});

	it("clears promptInFlight on first event", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		// promptInFlight should be true (set by normal path)
		expect(userState.promptInFlight).toBe(true);

		fireEvent({ type: "agent_start", messages: [] });
		await settle();

		expect(userState.promptInFlight).toBe(false);
	});

	it("sends DONE marker on agent_end", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		fireEvent({ type: "agent_end", messages: [] });
		// DONE has a 150ms delay
		await settle(400);

		expect(mockSafeSend).toHaveBeenCalledWith(api, 100, "🦀 _dreb DONE_");
	});

	it("does not send DONE when stopRequested", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		userState.stopRequested = true;
		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		const doneCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2]?.includes("DONE"));
		expect(doneCalls).toHaveLength(0);
	});

	it("does not send DONE when pendingRetry is set", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		// Need to import to manipulate the display state
		const { createEventDisplay } = await import("../src/handlers/events.js");

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockSafeSend.mockClear();

		// handleAgentEvent is mocked, so we need to simulate pendingRetry
		// by making the mocked handleAgentEvent set pendingRetry on the display.
		// The display is created internally by sendPrompt. We access it through
		// the createEventDisplay mock's return value.
		const mockCreateEventDisplay = vi.mocked(createEventDisplay);
		const display = mockCreateEventDisplay.mock.results[mockCreateEventDisplay.mock.results.length - 1]?.value;
		if (display) {
			// Simulate auto_retry_start setting pendingRetry before agent_end fires
			display.pendingRetry = true;
		}

		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		const doneCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2]?.includes("DONE"));
		expect(doneCalls).toHaveLength(0);
	});

	it("persists session on agent_end completion", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts({ userId: 42 }));
		await settle();

		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		expect(bridge.refreshSessionInfo).toHaveBeenCalled();
		expect(mockSetUserSession).toHaveBeenCalledWith(42, "test-session");
	});

	it("calls cleanupUploads on completion", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		sendPrompt(api, userState, defaultOpts());
		await settle();
		mockCleanupUploads.mockClear();

		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		expect(mockCleanupUploads).toHaveBeenCalled();
	});

	it("resets completion state on agent_start (allows multiple turns)", async () => {
		const api = createApi();
		const { bridge, fireEvent } = createBridge();
		const userState = createUserState({ bridge: bridge as any });

		// First turn
		sendPrompt(api, userState, defaultOpts());
		await settle();
		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		mockSafeSend.mockClear();

		// Second turn on same bridge — simulate new prompt
		sendPrompt(api, userState, defaultOpts());
		await settle();

		// agent_start resets completionFired
		fireEvent({ type: "agent_start", messages: [] });
		fireEvent({ type: "agent_end", messages: [] });
		await settle(400);

		const doneCalls = mockSafeSend.mock.calls.filter((c: any[]) => c[2]?.includes("DONE"));
		expect(doneCalls).toHaveLength(1);
	});
});
