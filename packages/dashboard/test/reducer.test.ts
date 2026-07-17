import { describe, expect, it } from "vitest";
import {
	applySessionEvent,
	createSessionViewState,
	dismissToast,
	MAX_COMPLETED_BACKGROUND_AGENTS,
	messagesToEntries,
	resolveUiRequest,
} from "../src/client/state/reducer.js";
import type { BackgroundAgentDto } from "../src/shared/protocol.js";

function makeState() {
	return createSessionViewState("k1");
}

function backgroundAgent(agentId: string, startedAt: string, status: BackgroundAgentDto["status"]): BackgroundAgentDto {
	return {
		agentId,
		agentType: "Explore",
		taskSummary: `task ${agentId}`,
		startedAt,
		status,
	};
}

describe("messagesToEntries — hydration", () => {
	it("converts user, assistant (text+thinking+tools), and toolResult messages", () => {
		const entries = messagesToEntries([
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				model: "m1",
				timestamp: 2,
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "hi there" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
				],
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file body" }] },
		]);

		expect(entries.map((e) => e.kind)).toEqual(["user", "assistant", "tool"]);
		const user = entries[0];
		expect(user).toMatchObject({ kind: "user", text: "hello" });
		const tool = entries.find((e) => e.kind === "tool");
		expect(tool).toMatchObject({ toolName: "read", status: "done", resultText: "file body" });
		const assistant = entries.find((e) => e.kind === "assistant");
		expect(assistant).toMatchObject({
			blocks: [
				{ kind: "thinking", text: "hmm" },
				{ kind: "text", text: "hi there" },
			],
			model: "m1",
		});
	});

	it("preserves assistant content order around tool calls", () => {
		const entries = messagesToEntries([
			{
				role: "assistant",
				model: "m1",
				timestamp: 2,
				content: [
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
					{ type: "text", text: "after" },
				],
			},
		]);

		expect(entries.map((e) => e.kind)).toEqual(["assistant", "tool", "assistant"]);
		expect(entries[0]).toMatchObject({ kind: "assistant", blocks: [{ kind: "text", text: "before" }] });
		expect(entries[1]).toMatchObject({ kind: "tool", toolCallId: "t1" });
		expect(entries[2]).toMatchObject({ kind: "assistant", blocks: [{ kind: "text", text: "after" }] });
	});

	it("hydrates background-agent completion messages as agent-result entries", () => {
		const entries = messagesToEntries([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "<background-agent-complete>\nBackground agent bg1 (Explore) completed.\n\n**done**\n</background-agent-complete>",
					},
				],
				timestamp: 7,
			},
		]);

		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "agent-result",
			header: "Background agent bg1 (Explore) completed.",
			text: "**done**",
			timestamp: 7,
		});
	});

	it("marks failed tool results as errors", () => {
		const entries = messagesToEntries([
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "boom" }],
			},
		]);
		expect(entries[0]).toMatchObject({ kind: "tool", status: "error", resultText: "boom" });
	});

	it("renders bashExecution and custom messages", () => {
		const entries = messagesToEntries([
			{ role: "bashExecution", command: "ls", output: "a b c", timestamp: 3 } as any,
			{ role: "custom", customType: "my-ext", displayText: "widget text" } as any,
		]);
		expect(entries[0]).toMatchObject({ kind: "tool", toolName: "bash (user)", resultText: "a b c" });
		expect(entries[1]).toMatchObject({ kind: "custom", tag: "my-ext", text: "widget text" });
	});
});

describe("applySessionEvent — streaming lifecycle", () => {
	it("streams text deltas into an assistant entry and finalizes on message_end", () => {
		const state = makeState();
		applySessionEvent(state, { type: "agent_start" });
		expect(state.streaming).toBe(true);

		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
		});

		const tail = state.entries[state.entries.length - 1];
		expect(tail).toMatchObject({ kind: "assistant", streaming: true, blocks: [{ kind: "text", text: "hello" }] });

		applySessionEvent(state, {
			type: "message_end",
			message: { role: "assistant", model: "m1", content: [{ type: "text", text: "hello world" }] },
		});
		expect(state.entries[state.entries.length - 1]).toMatchObject({
			kind: "assistant",
			streaming: false,
			blocks: [{ kind: "text", text: "hello world" }],
			model: "m1",
		});

		applySessionEvent(state, { type: "agent_end", messages: [] });
		expect(state.streaming).toBe(false);
		expect(state.workingText).toBeUndefined();
	});

	it("streams thinking deltas into thinking blocks", () => {
		const state = makeState();
		applySessionEvent(state, { type: "agent_start" });
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "pondering" },
		});
		const tail = state.entries[0];
		expect(tail).toMatchObject({ kind: "assistant", blocks: [{ kind: "thinking", text: "pondering" }] });
	});

	it("keeps streamed assistant text before subsequent tool cards", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "I'll read it" },
		});
		applySessionEvent(state, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "/x" },
		});

		expect(state.entries.map((e) => e.kind)).toEqual(["assistant", "tool"]);
		expect(state.entries[0]).toMatchObject({
			kind: "assistant",
			blocks: [
				{ kind: "thinking", text: "hmm" },
				{ kind: "text", text: "I'll read it" },
			],
		});
		expect(state.entries[1]).toMatchObject({ kind: "tool", toolCallId: "t1" });
	});

	it("renders live background-agent completion messages as agent-result entries", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "message_end",
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: "<background-agent-complete>\nBackground agent bg2 (Implement) completed.\n\nresult body\n</background-agent-complete>",
					},
				],
			},
		});

		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({
			kind: "agent-result",
			header: "Background agent bg2 (Implement) completed.",
			text: "result body",
		});
	});

	it("tracks tool card lifecycle: start → update → end", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		});
		expect(state.entries[0]).toMatchObject({ kind: "tool", status: "running", toolName: "bash" });
		expect(state.workingText).toBe("bash");

		applySessionEvent(state, {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		expect(state.entries[0]).toMatchObject({ resultText: "partial" });

		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done output" }] },
			isError: false,
		});
		expect(state.entries[0]).toMatchObject({ status: "done", resultText: "done output" });
	});

	it("marks tool errors", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: {},
			isError: true,
		});
		expect(state.entries[0]).toMatchObject({ kind: "tool", status: "error" });
	});

	it("stream_retry discards the streaming tail and shows a warning", () => {
		const state = makeState();
		applySessionEvent(state, { type: "agent_start" });
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial tok" },
		});
		expect(state.entries).toHaveLength(1);

		applySessionEvent(state, { type: "stream_retry", attempt: 1, maxAttempts: 3, error: "boom" });
		expect(state.entries).toHaveLength(0);
		expect(state.statusEntries.some((s) => s.key === "retry" && s.tone === "warning")).toBe(true);
	});

	it("length_retry discards the streaming tail and shows a warning", () => {
		const state = makeState();
		applySessionEvent(state, { type: "agent_start" });
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial tok" },
		});
		expect(state.entries).toHaveLength(1);

		applySessionEvent(state, { type: "length_retry", attempt: 2, maxAttempts: 4 });
		expect(state.entries).toHaveLength(0);
		expect(state.statusEntries).toContainEqual({
			key: "retry",
			text: "response truncated, retrying with larger budget (2/4)",
			tone: "warning",
		});
	});
});

describe("applySessionEvent — session-level events", () => {
	it("tasks_update replaces the task list", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "tasks_update",
			tasks: [
				{ id: "a", title: "a", status: "completed" },
				{ id: "b", title: "b", status: "in_progress" },
			],
		});
		expect(state.tasks).toEqual([
			{ id: "a", title: "a", status: "completed" },
			{ id: "b", title: "b", status: "in_progress" },
		]);
	});

	it("suggest_next sets the suggestion chip", () => {
		const state = makeState();
		applySessionEvent(state, { type: "suggest_next", command: "/skill:mach6-push" });
		expect(state.suggestedCommand).toBe("/skill:mach6-push");
	});

	it("agent_start clears suggestedCommand", () => {
		const state = makeState();
		applySessionEvent(state, { type: "suggest_next", command: "/skill:mach6-push" });
		expect(state.suggestedCommand).toBe("/skill:mach6-push");

		applySessionEvent(state, { type: "agent_start" });
		expect(state.suggestedCommand).toBeUndefined();
	});

	it("session_name_changed updates the live session display name", () => {
		const state = makeState();
		applySessionEvent(state, { type: "session_name_changed", name: "renamed live" });
		expect(state.sessionName).toBe("renamed live");
	});

	it("compaction produces a summary entry and clears the status line", () => {
		const state = makeState();
		applySessionEvent(state, { type: "auto_compaction_start", reason: "threshold" });
		expect(state.compacting).toBe(true);
		applySessionEvent(state, {
			type: "auto_compaction_end",
			result: { tokensBefore: 52410, summary: "earlier work summarized" },
			aborted: false,
			willRetry: false,
		});
		expect(state.compacting).toBe(false);
		expect(state.entries[0]).toMatchObject({ kind: "summary", label: "compaction", tokensBefore: 52410 });
	});

	it("compaction errors surface an error status entry", () => {
		const state = makeState();
		applySessionEvent(state, { type: "auto_compaction_start", reason: "threshold" });

		applySessionEvent(state, {
			type: "auto_compaction_end",
			errorMessage: "summarizer failed",
			aborted: false,
			willRetry: false,
		});

		expect(state.compacting).toBe(false);
		expect(state.statusEntries).toContainEqual({
			key: "compaction-error",
			text: "summarizer failed",
			tone: "error",
		});
		expect(state.needsAttention).toBe(true);
	});

	it("aborted compaction does not append a summary entry", () => {
		const state = makeState();
		applySessionEvent(state, { type: "auto_compaction_start", reason: "manual" });

		applySessionEvent(state, {
			type: "auto_compaction_end",
			result: { tokensBefore: 1234, summary: "should not render" },
			aborted: true,
			willRetry: false,
		});

		expect(state.compacting).toBe(false);
		expect(state.entries).toHaveLength(0);
		expect(state.statusEntries.some((s) => s.key === "compaction")).toBe(false);
	});

	it("auto_retry failure surfaces an error status and lastError", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "429",
		});
		expect(state.statusEntries.some((s) => s.key === "retry")).toBe(true);
		applySessionEvent(state, { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limited" });
		expect(state.lastError).toBe("429 rate limited");
		expect(state.needsAttention).toBe(true);
	});

	it("parent_paused sets a warning status cleared by agent_end", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "parent_paused_for_background_agents",
			runningAgentCount: 2,
			turnsUsed: 10,
			turnLimit: 10,
		});
		expect(state.statusEntries.some((s) => s.key === "paused")).toBe(true);
		applySessionEvent(state, { type: "agent_end", messages: [] });
		expect(state.statusEntries.some((s) => s.key === "paused")).toBe(false);
	});
});

describe("applySessionEvent — extension UI", () => {
	it("blocking requests queue as modals; resolveUiRequest dismisses; attention follows", () => {
		const state = makeState();
		applySessionEvent(state, { type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });
		expect(state.uiRequests).toHaveLength(1);
		expect(state.needsAttention).toBe(true);

		resolveUiRequest(state, "u1");
		expect(state.uiRequests).toHaveLength(0);
		expect(state.needsAttention).toBe(false);
	});

	it("agent_start clears pending UI requests (server resolved them)", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "u1",
			method: "select",
			title: "Pick",
			options: ["a"],
		});
		applySessionEvent(state, { type: "agent_start" });
		expect(state.uiRequests).toHaveLength(0);
	});

	it("notify → toast, setStatus → keyed status entries, setWidget/setTitle/set_editor_text", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "n1",
			method: "notify",
			message: "heads up",
			notifyType: "warning",
		});
		expect(state.toasts[0]).toMatchObject({ text: "heads up", tone: "warning" });

		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "s1",
			method: "setStatus",
			statusKey: "k",
			statusText: "busy",
		});
		expect(state.statusEntries.some((s) => s.key === "ext:k" && s.text === "busy")).toBe(true);
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "s2",
			method: "setStatus",
			statusKey: "k",
			statusText: undefined,
		});
		expect(state.statusEntries.some((s) => s.key === "ext:k")).toBe(false);

		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "w1",
			method: "setWidget",
			widgetPlacement: "aboveEditor",
			widgetLines: ["l1"],
		});
		expect(state.widgets.above).toEqual(["l1"]);

		applySessionEvent(state, { type: "extension_ui_request", id: "t1", method: "setTitle", title: "new title" });
		expect(state.title).toBe("new title");

		applySessionEvent(state, { type: "extension_ui_request", id: "e1", method: "set_editor_text", text: "prefill" });
		expect(state.composerPrefill).toBe("prefill");
	});

	it("caps toasts to the newest 20 entries", () => {
		const state = makeState();
		for (let i = 0; i < 25; i++) {
			applySessionEvent(state, {
				type: "extension_ui_request",
				id: `n${i}`,
				method: "notify",
				message: `toast-${i}`,
			});
		}

		expect(state.toasts).toHaveLength(20);
		expect(state.toasts[0]).toMatchObject({ text: "toast-5" });
		expect(state.toasts.at(-1)).toMatchObject({ text: "toast-24" });

		applySessionEvent(state, {
			type: "extension_error",
			extensionPath: "/x.ts",
			event: "tool_call",
			error: "final",
		});

		expect(state.toasts).toHaveLength(20);
		expect(state.toasts[0]).toMatchObject({ text: "toast-6" });
		expect(state.toasts.at(-1)).toMatchObject({ text: "extension error: final", tone: "error" });
	});

	it("extension_error produces an error toast", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_error",
			extensionPath: "/x.ts",
			event: "tool_call",
			error: "kaboom",
		});
		expect(state.toasts.some((t) => t.tone === "error" && t.text.includes("kaboom"))).toBe(true);
	});

	it("dismissToast removes only the matching toast", () => {
		const state = makeState();
		applySessionEvent(state, { type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "one" });
		applySessionEvent(state, { type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "two" });
		const [first, second] = state.toasts;
		expect(first).toBeDefined();
		expect(second).toBeDefined();

		dismissToast(state, first!.id);
		expect(state.toasts).toHaveLength(1);
		expect(state.toasts[0]).toMatchObject({ id: second!.id, text: expect.stringContaining("two") });
	});
});

describe("applySessionEvent — subagent relay", () => {
	it("background lifecycle events track agents; relayed events build a live sub-transcript", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "background_agent_start",
			agentId: "bg1",
			agentType: "Explore",
			taskSummary: "look",
			sessionDir: "/dir",
		});
		expect(state.backgroundAgents.bg1).toMatchObject({ status: "running", sessionDir: "/dir" });

		applySessionEvent(state, { type: "background_agent_event", agentId: "bg1", event: { type: "session", id: "s" } });
		applySessionEvent(state, {
			type: "background_agent_event",
			agentId: "bg1",
			event: { type: "agent_start", model: { id: "haiku" } },
		});
		applySessionEvent(state, {
			type: "background_agent_event",
			agentId: "bg1",
			event: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		});
		applySessionEvent(state, {
			type: "background_agent_event",
			agentId: "bg1",
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "scanning" },
			},
		});

		const sub = state.subagents.bg1;
		expect(sub.model).toBe("haiku");
		expect(sub.streaming).toBe(true);
		expect(sub.entries[0]).toMatchObject({ kind: "assistant", blocks: [{ kind: "text", text: "scanning" }] });

		applySessionEvent(state, { type: "background_agent_end", agentId: "bg1", agentType: "Explore", success: true });
		expect(state.backgroundAgents.bg1?.status).toBe("completed");
		expect(state.subagents.bg1?.streaming).toBe(false);
	});

	it("caps completed background agents and evicts their subagent transcripts while preserving running agents", () => {
		const state = makeState();
		for (let i = 0; i <= MAX_COMPLETED_BACKGROUND_AGENTS; i++) {
			const agentId = `done-${i.toString().padStart(2, "0")}`;
			state.backgroundAgents[agentId] = backgroundAgent(agentId, new Date(i * 1000).toISOString(), "completed");
			state.subagents[agentId] = { agentId, entries: [{ kind: "user", text: `transcript ${i}` }], streaming: false };
		}
		state.backgroundAgents["running-old"] = backgroundAgent("running-old", new Date(0).toISOString(), "running");
		state.subagents["running-old"] = {
			agentId: "running-old",
			entries: [{ kind: "user", text: "live" }],
			streaming: true,
		};
		state.backgroundAgents["ending-new"] = backgroundAgent(
			"ending-new",
			new Date((MAX_COMPLETED_BACKGROUND_AGENTS + 2) * 1000).toISOString(),
			"running",
		);
		state.subagents["ending-new"] = {
			agentId: "ending-new",
			entries: [{ kind: "user", text: "ending" }],
			streaming: true,
		};

		applySessionEvent(state, { type: "background_agent_end", agentId: "ending-new", success: true });

		const completed = Object.values(state.backgroundAgents).filter((agent) => agent.status !== "running");
		expect(completed).toHaveLength(MAX_COMPLETED_BACKGROUND_AGENTS);
		expect(state.backgroundAgents["done-00"]).toBeUndefined();
		expect(state.backgroundAgents["done-01"]).toBeUndefined();
		expect(state.subagents["done-00"]).toBeUndefined();
		expect(state.subagents["done-01"]).toBeUndefined();
		expect(state.backgroundAgents["done-02"]).toBeDefined();
		expect(state.subagents["done-02"]).toBeDefined();
		expect(state.backgroundAgents["running-old"]?.status).toBe("running");
		expect(state.subagents["running-old"]?.streaming).toBe(true);
		expect(state.backgroundAgents["ending-new"]?.status).toBe("completed");
		expect(state.subagents["ending-new"]?.streaming).toBe(false);
	});
});
