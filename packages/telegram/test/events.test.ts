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
		const state = makeState({ toolCount: 5, textBlocks: ["some text"], visibleToolResultCount: 1 });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [{ stopReason: "error", errorMessage: "overloaded" }],
		});

		expect(state.done).toBe(false);
		expect(state.pendingRetry).toBe(true);
		// Per-cycle state is reset
		expect(state.textBlocks).toEqual([]);
		expect(state.visibleToolResultCount).toBe(0);
		expect(state.toolCount).toBe(0);
	});

	it("does NOT set done for 'ended without' errors (stream termination)", async () => {
		const send = vi.fn();
		const state = makeState({ toolCount: 2, textBlocks: ["partial"], visibleToolResultCount: 1 });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [{ stopReason: "error", errorMessage: "request ended without sending any chunks" }],
		});

		expect(state.done).toBe(false);
		expect(state.pendingRetry).toBe(true);
		expect(state.textBlocks).toEqual([]);
		expect(state.visibleToolResultCount).toBe(0);
		expect(state.toolCount).toBe(0);
	});

	it("does NOT set done when background agents are still running", async () => {
		const send = vi.fn();
		const state = makeState({ visibleToolResultCount: 1 });
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
		expect(state.visibleToolResultCount).toBe(0);
		expect(state.toolCount).toBe(0);
	});

	it("does NOT send no-response after visible tool result output", async () => {
		const send = vi.fn();
		const state = makeState({ visibleToolResultCount: 1 });

		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [],
		});

		expect(send).not.toHaveBeenCalledWith("(No response)");
		expect(state.done).toBe(true);
	});

	it("does NOT send no-response after a visible tool result in the same cycle", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "suggest_next",
			result: {
				content: [{ type: "text", text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact", summary: "Done." },
			},
		});
		await handleAgentEvent(send, mockApi(), state, {
			type: "agent_end",
			messages: [],
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("Done."), true);
		expect(send).not.toHaveBeenCalledWith("(No response)");
		expect(state.done).toBe(true);
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
// tool_execution_end — visible tool results
// ---------------------------------------------------------------------------

describe("tool_execution_end", () => {
	it("sends suggest_next summary and suggestion as a permanent long message", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "suggest_next",
			result: {
				content: [{ type: "text", text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact", summary: "Done with refactor." },
			},
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("Done with refactor."), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("→ /compact"), true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends suggest_next suggestion without summary", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "suggest_next",
			result: {
				content: [{ type: "text", text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact" },
			},
		});

		expect(send).toHaveBeenCalledWith("→ /compact", true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends suggest_next error text when details are absent", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "suggest_next",
			isError: true,
			result: {
				content: [{ type: "text", text: "Error: command is empty" }],
				details: undefined,
			},
		});

		expect(send).toHaveBeenCalledWith("Error: command is empty", true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("flushes accumulated tool summaries before sending a visible tool result", async () => {
		const send = vi.fn();
		const state = makeState({ toolsSinceText: ["🔧 *bash*", "💡 *suggest\\_next*: /compact"] });

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "suggest_next",
			result: {
				content: [{ type: "text", text: "Suggestion registered: /compact" }],
				details: { suggestion: "/compact" },
			},
		});

		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[0][0]).toContain("📋 *2 tools*:");
		expect(send.mock.calls[0][0]).toContain("🔧 *bash*");
		expect(send.mock.calls[0][0]).toContain("💡 *suggest\\_next*: /compact");
		expect(send.mock.calls[0][1]).toBe(true);
		expect(send.mock.calls[1]).toEqual(["→ /compact", true]);
		expect(state.toolsSinceText).toEqual([]);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends search result text via the long-message path", async () => {
		const send = vi.fn();
		const state = makeState();
		const results = "1. packages/telegram/src/handlers/events.ts\\n   scores: bm25=1.00";

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "search",
			result: {
				content: [{ type: "text", text: results }],
				details: { resultCount: 1, indexBuilt: false, indexStats: { files: 10, chunks: 25 } },
			},
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("Search results (1)"), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("packages/telegram/src/handlers/events.ts"), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("Index: 10 files, 25 chunks"), true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends search no-results text", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "search",
			result: {
				content: [{ type: "text", text: "No results found." }],
				details: { resultCount: 0, indexBuilt: false },
			},
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("No results found."), true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends wait status with running agent context", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "wait",
			result: {
				content: [{ type: "text", text: "Waiting…" }],
				details: {
					reason: "background agents",
					runningAgents: [
						{ agentId: "abc1234567890", agentType: "code-reviewer", taskSummary: "reviewing changes" },
					],
				},
			},
		});

		expect(send).toHaveBeenCalledWith(expect.stringContaining("Waiting: background agents"), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("abc123456789"), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("code-reviewer"), true);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("reviewing changes"), true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends wait status without running agents", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "wait",
			result: {
				content: [{ type: "text", text: "Waiting…" }],
				details: { reason: undefined, runningAgents: [] },
			},
		});

		expect(send).toHaveBeenCalledWith("⏳ Waiting…", true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("sends wait reason when no background agents are running", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "wait",
			result: {
				content: [{ type: "text", text: "Waiting…" }],
				details: { reason: "compacting context", runningAgents: [] },
			},
		});

		expect(send).toHaveBeenCalledWith("⏳ Waiting: compacting context", true);
		expect(state.visibleToolResultCount).toBe(1);
	});

	it("does not send general tool results that are not allowlisted", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_end",
			toolName: "bash",
			result: { content: [{ type: "text", text: "stdout" }] },
		});

		expect(send).not.toHaveBeenCalled();
		expect(state.visibleToolResultCount).toBe(0);
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

	it("formats suggest_next command in toolsSinceText", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "suggest_next",
			args: { command: "/skill:mach6-push" },
		});

		expect(state.toolsSinceText[0]).toContain("suggest\\_next");
		expect(state.toolsSinceText[0]).toContain("/skill:mach6-push");
	});

	it("formats search query and options in toolsSinceText", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "search",
			args: {
				query: "AuthMiddleware",
				limit: 5,
				restrictToDir: "src/auth",
				searchDir: "packages/coding-agent",
				rebuild: true,
			},
		});

		expect(state.toolsSinceText[0]).toContain("search");
		expect(state.toolsSinceText[0]).toContain("AuthMiddleware");
		expect(state.toolsSinceText[0]).toContain("limit: 5");
		expect(state.toolsSinceText[0]).toContain("in: src/auth");
		expect(state.toolsSinceText[0]).toContain("project: packages/coding-agent");
		expect(state.toolsSinceText[0]).toContain("rebuild: true");
	});

	it("formats wait reason in toolsSinceText and handles empty args", async () => {
		const send = vi.fn();
		const state = makeState();

		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "wait",
			args: { reason: "background agents" },
		});
		await handleAgentEvent(send, mockApi(), state, {
			type: "tool_execution_start",
			toolName: "wait",
			args: {},
		});

		expect(state.toolsSinceText[0]).toContain("wait");
		expect(state.toolsSinceText[0]).toContain("background agents");
		expect(state.toolsSinceText[1]).toContain("wait");
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
