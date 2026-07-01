import { describe, expect, it } from "vitest";
import {
	applyDashboardEvent,
	categorizeEvent,
	clearSuggestion,
	createInitialDashboardState,
	hydrateMessages,
	hydrateRuntimeState,
} from "../src/client/state.js";

describe("dashboard client state", () => {
	it("categorizes streaming, message, lifecycle, and tool events", () => {
		expect(categorizeEvent({ type: "message_update" })).toBe("stream");
		expect(categorizeEvent({ type: "message_end" })).toBe("message");
		expect(categorizeEvent({ type: "agent_start" })).toBe("lifecycle");
		expect(categorizeEvent({ type: "tool_execution_update" })).toBe("tool");
		expect(categorizeEvent({ type: "extension_error" })).toBe("system");
	});

	it("hydrates runtime state and replaces loaded messages", () => {
		let state = createInitialDashboardState();
		state = hydrateRuntimeState(state, { sessionId: "s1", thinkingLevel: "medium", isStreaming: true });
		state = hydrateMessages(state, [{ role: "user", content: "hello", timestamp: 1 }]);

		expect(state.runtime?.sessionId).toBe("s1");
		expect(state.isStreaming).toBe(true);
		expect(state.messages).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
	});

	it("tracks streaming message updates until completion", () => {
		let state = createInitialDashboardState();
		state = applyDashboardEvent(state, { type: "agent_start" }, 10);
		state = applyDashboardEvent(
			state,
			{
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 20 },
				assistantMessageEvent: { type: "text_delta", delta: "hel" },
			},
			20,
		);

		expect(state.isStreaming).toBe(true);
		expect(state.streamMessage?.content).toEqual([{ type: "text", text: "hel" }]);
		expect(state.events.map((event) => event.category)).toEqual(["lifecycle", "stream"]);

		state = applyDashboardEvent(
			state,
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 20 },
			},
			30,
		);
		state = applyDashboardEvent(state, { type: "agent_end", messages: state.messages }, 40);

		expect(state.streamMessage).toBeUndefined();
		expect(state.isStreaming).toBe(false);
		expect(state.messages).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 20 },
		]);
	});

	it("updates task lists from tasks_update events", () => {
		const state = applyDashboardEvent(
			createInitialDashboardState(),
			{
				type: "tasks_update",
				tasks: [
					{ id: "1", title: "Read files", status: "completed" },
					{ id: "2", title: "Implement UI", status: "in_progress" },
				],
			},
			100,
		);

		expect(state.tasks).toHaveLength(2);
		expect(state.tasks[1]).toMatchObject({ title: "Implement UI", status: "in_progress" });
		expect(state.events[0]?.category).toBe("task");
	});

	it("stores and clears suggest-next commands without duplicates", () => {
		let state = createInitialDashboardState();
		state = applyDashboardEvent(state, { type: "suggest_next", command: "/test" }, 100);
		state = applyDashboardEvent(state, { type: "suggest_next", command: "/test" }, 101);
		state = applyDashboardEvent(state, { type: "suggest_next", command: "/build" }, 102);

		expect(state.suggestions).toEqual(["/test", "/build"]);
		expect(state.events.map((event) => event.category)).toEqual(["suggestion", "suggestion", "suggestion"]);

		state = clearSuggestion(state, "/test");
		expect(state.suggestions).toEqual(["/build"]);
	});

	it("tracks subagent lifecycle and parent pause events", () => {
		let state = createInitialDashboardState();
		state = applyDashboardEvent(
			state,
			{ type: "background_agent_start", agentId: "a1", agentType: "reviewer", taskSummary: "Check tests" },
			100,
		);
		state = applyDashboardEvent(
			state,
			{ type: "parent_paused_for_background_agents", runningAgentCount: 1, turnsUsed: 3, turnLimit: 8 },
			120,
		);
		state = applyDashboardEvent(
			state,
			{ type: "background_agent_end", agentId: "a1", agentType: "reviewer", success: true },
			150,
		);

		expect(state.parentPause).toMatchObject({ runningAgentCount: 1, turnsUsed: 3, turnLimit: 8 });
		expect(state.subagents).toEqual([
			expect.objectContaining({
				id: "a1",
				agentType: "reviewer",
				taskSummary: "Check tests",
				status: "succeeded",
				startedAt: 100,
				endedAt: 150,
			}),
		]);
		expect(state.events.every((event) => event.category === "subagent")).toBe(true);
	});
});
