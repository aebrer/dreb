/**
 * Tests for handleAgentEvent and createEventDisplay in events.ts.
 *
 * Exercises the main event handler paths: message delivery, agent lifecycle,
 * auto-retry, and tool tracking.
 */

import { describe, expect, it, vi } from "vitest";
import { createEventDisplay, type EventDisplayState, handleAgentEvent } from "../src/handlers/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock Api sufficient for event handler tests */
function mockApi(): any {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
		editMessageText: vi.fn().mockResolvedValue(true),
		deleteMessage: vi.fn().mockResolvedValue(true),
	};
}

/** Create a fresh EventDisplayState via createEventDisplay */
function makeState(overrides?: Partial<EventDisplayState>): EventDisplayState {
	const api = mockApi();
	const state = createEventDisplay(api, 123, 456, null);
	if (overrides) Object.assign(state, overrides);
	return state;
}

// ---------------------------------------------------------------------------
// message_end — assistant text
// ---------------------------------------------------------------------------

describe("message_end", () => {
	it("sends assistant text via send() with long: true", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello from the agent" }],
			},
		});

		expect(send).toHaveBeenCalledWith("Hello from the agent", true);
	});

	it("sends subagent toolResult content with prefix", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "subagent",
				content: [{ type: "text", text: "Subagent found 3 issues" }],
			},
		});

		expect(send).toHaveBeenCalledWith("🤖 *Subagent result:*\nSubagent found 3 issues", true);
	});

	it("extracts content from background-agent-complete XML tags in user messages", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: "<background-agent-complete>\nTask finished successfully\n</background-agent-complete>",
					},
				],
			},
		});

		expect(send).toHaveBeenCalledWith("🤖 *Background agent complete:*\nTask finished successfully", true);
	});

	it("does NOT call send() for user messages without background-agent-complete tag", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "Just a regular user message" }],
			},
		});

		expect(send).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// agent_end
// ---------------------------------------------------------------------------

describe("agent_end", () => {
	it("sets state.done = true on normal completion", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [],
		});

		expect(state.done).toBe(true);
	});

	it("flushes accumulated tools on normal completion", async () => {
		const send = vi.fn();
		const state = makeState({ toolsSinceText: ["🔧 *bash*\n`ls`", "📖 *read*: `foo.ts`"] });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [],
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("📋 *2 tools*:"), true);
		expect(state.toolsSinceText).toEqual([]);
		expect(state.done).toBe(true);
	});

	it("does NOT set done for retryable errors, sets pendingRetry and resets per-cycle state", async () => {
		const send = vi.fn();
		const state = makeState({ toolCount: 5, textBlocks: ["some text"] });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [{ stopReason: "error", errorMessage: "overloaded" }],
		});

		expect(state.done).toBe(false);
		expect(state.pendingRetry).toBe(true);
		// Per-cycle state is reset
		expect(state.textBlocks).toEqual([]);
		expect(state.toolCount).toBe(0);
	});

	it("does NOT set done for 'ended without' errors (stream termination)", async () => {
		const send = vi.fn();
		const state = makeState({ toolCount: 2, textBlocks: ["partial"] });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [{ stopReason: "error", errorMessage: "request ended without sending any chunks" }],
		});

		expect(state.done).toBe(false);
		expect(state.pendingRetry).toBe(true);
		expect(state.textBlocks).toEqual([]);
		expect(state.toolCount).toBe(0);
	});

	it("does NOT set done when background agents are still running", async () => {
		const send = vi.fn();
		const state = makeState();
		state.backgroundAgents.set("bg-1", {
			agentId: "bg-1",
			agentType: "researcher",
			taskSummary: "Researching...",
			startTime: Date.now(),
		});

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [],
		});

		expect(state.done).toBe(false);
		// Per-cycle state is reset
		expect(state.textBlocks).toEqual([]);
		expect(state.toolCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// auto_retry_start / auto_retry_end
// ---------------------------------------------------------------------------

describe("auto_retry_start", () => {
	it("sets retryInProgress and clears pendingRetry", async () => {
		const send = vi.fn();
		const state = makeState({ pendingRetry: true });

		await handleAgentEvent(send, mockApi(), state, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 5000,
			errorMessage: "overloaded",
		});

		expect(state.retryInProgress).toBe(true);
		expect(state.pendingRetry).toBe(false);
		expect(state.retryAttempt).toBe(1);
	});
});

describe("auto_retry_end", () => {
	it("sends error message on failure", async () => {
		const send = vi.fn();
		const state = makeState({ retryInProgress: true, retryAttempt: 2 });

		await handleAgentEvent(send, mockApi(), state, {
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "Service unavailable after retries",
		});

		expect(state.retryInProgress).toBe(false);
		expect(state.retryAttempt).toBe(0);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("Retry failed (3 attempts)"), true);
	});

	it("does not send error message on success", async () => {
		const send = vi.fn();
		const state = makeState({ retryInProgress: true });

		await handleAgentEvent(send, mockApi(), state, {
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});

		expect(state.retryInProgress).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// tool_execution_start
// ---------------------------------------------------------------------------

describe("tool_execution_start", () => {
	it("increments toolCount and adds to toolsSinceText", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "ls -la" },
		});

		expect(state.toolCount).toBe(1);
		expect(state.toolsSinceText).toHaveLength(1);
		expect(state.toolsSinceText[0]).toContain("bash");
		expect(state.toolsSinceText[0]).toContain("ls -la");
	});

	it("does not add tasks_update to toolsSinceText (but still increments count)", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "tasks_update",
			args: {},
		});

		expect(state.toolCount).toBe(1);
		expect(state.toolsSinceText).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Buddy event forwarding
// ---------------------------------------------------------------------------

describe("buddy event forwarding", () => {
	it("forwards tool_execution_end to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		const event = {
			type: "tool_execution_end",
			toolName: "bash",
			args: { command: "ls" },
			output: "file.txt",
		};

		await handleAgentEvent(send, mockApi(), state, event);

		expect(handleEvent).toHaveBeenCalledOnce();
		expect(handleEvent).toHaveBeenCalledWith(event);
	});

	it("forwards message_end with assistant message to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
			},
		};

		await handleAgentEvent(send, mockApi(), state, event);

		expect(handleEvent).toHaveBeenCalledOnce();
		expect(handleEvent).toHaveBeenCalledWith(event);
	});

	it("does NOT forward message_end with toolResult role to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "subagent",
				content: [{ type: "text", text: "Result" }],
			},
		});

		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("does NOT forward message_end with user role to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		await handleAgentEvent(send, mockApi(), state, {
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "Just a user message" }],
			},
		});

		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("forwards agent_end to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		const event = {
			type: "agent_end",
			messages: [],
		};

		await handleAgentEvent(send, mockApi(), state, event);

		expect(handleEvent).toHaveBeenCalledOnce();
		expect(handleEvent).toHaveBeenCalledWith(event);
	});

	it("does NOT forward tool_execution_start to buddyController", async () => {
		const send = vi.fn();
		const handleEvent = vi.fn();
		const state = makeState();
		state.buddyController = { handleEvent };

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "ls" },
		});

		expect(handleEvent).not.toHaveBeenCalled();
	});
});
