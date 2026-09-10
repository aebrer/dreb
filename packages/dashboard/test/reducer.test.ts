import { describe, expect, it } from "vitest";
import {
	applySessionEvent,
	createSessionViewState,
	dismissToast,
	type ExtensionUiRequest,
	MAX_COMPLETED_BACKGROUND_AGENTS,
	messagesToEntries,
	pendingQuestionsReason,
	resolveUiRequest,
	syncCompactionStatusEntry,
} from "../src/client/state/reducer.js";
import type { BackgroundAgentDto } from "../src/shared/protocol.js";

const IMAGE_ID = "a".repeat(64);
const SECOND_IMAGE_ID = "b".repeat(64);
const imageRef = (mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp", id = IMAGE_ID) => ({
	type: "image_reference" as const,
	id,
	mimeType,
	size: 1234,
});
const reducedImage = (mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp", id = IMAGE_ID) => ({
	id,
	mimeType,
	size: 1234,
});

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

	it("hydrates compactionSummary messages as compaction summary entries", () => {
		const entries = messagesToEntries([
			{ role: "compactionSummary", summary: "earlier work summarized", tokensBefore: 52410 },
			{ role: "user", content: "after compaction", timestamp: 3 },
		]);

		expect(entries.map((e) => e.kind)).toEqual(["summary", "user"]);
		expect(entries[0]).toMatchObject({
			kind: "summary",
			label: "compaction",
			text: "earlier work summarized",
			tokensBefore: 52410,
		});
	});

	it("falls back to a generic compaction summary when the message has no text", () => {
		const entries = messagesToEntries([{ role: "compactionSummary", tokensBefore: 1000 }]);
		expect(entries).toEqual([
			{ kind: "summary", label: "compaction", text: "context compacted", tokensBefore: 1000 },
		]);
	});

	it("retains uploaded-image references on hydrated user transcript entries", () => {
		const entries = messagesToEntries([
			{
				role: "user",
				content: [{ type: "text", text: "describe this" }, imageRef("image/png")],
				timestamp: 1,
			},
		]);

		expect(entries).toEqual([
			{
				kind: "user",
				text: "describe this",
				images: [reducedImage("image/png")],
				timestamp: 1,
			},
		]);
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

	it("extracts tool-result image blocks on the replay path (resync recovery)", () => {
		const entries = messagesToEntries([
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x.png" } }] },
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "Read image file [image/png]" }, imageRef("image/png")],
			},
		]);
		const tool = entries.find((e) => e.kind === "tool");
		expect(tool).toMatchObject({
			toolName: "read",
			status: "done",
			resultText: "Read image file [image/png]",
			images: [reducedImage("image/png")],
		});
	});

	it("attaches assistant failure metadata to the final segment around tool calls", () => {
		const entries = messagesToEntries([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "provider exploded",
				content: [
					{ type: "text", text: "before tool" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
					{ type: "thinking", thinking: "after thinking" },
					{ type: "text", text: "partial after tool" },
				],
			},
		]);

		expect(entries.map((entry) => entry.kind)).toEqual(["assistant", "tool", "assistant"]);
		expect(entries[0]).toMatchObject({ kind: "assistant", blocks: [{ kind: "text", text: "before tool" }] });
		expect(entries[0]).not.toHaveProperty("errorMessage", "provider exploded");
		expect(entries[2]).toMatchObject({
			kind: "assistant",
			stopReason: "error",
			errorMessage: "provider exploded",
			blocks: [
				{ kind: "thinking", text: "after thinking" },
				{ kind: "text", text: "partial after tool" },
			],
		});
	});

	it("creates an error-only assistant entry and falls back to Unknown error", () => {
		const entries = messagesToEntries([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "   ",
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
			},
		]);

		expect(entries.map((entry) => entry.kind)).toEqual(["tool", "assistant"]);
		expect(entries[1]).toMatchObject({
			kind: "assistant",
			blocks: [],
			stopReason: "error",
			errorMessage: "Unknown error",
		});
	});

	it("preserves aborted outcomes without classifying them as provider failures", () => {
		const entries = messagesToEntries([
			{
				role: "assistant",
				stopReason: "aborted",
				errorMessage: "not a provider failure",
				content: [{ type: "text", text: "cancelled partial" }],
			},
		]);

		expect(entries[0]).toMatchObject({ kind: "assistant", stopReason: "aborted" });
		expect((entries[0] as { errorMessage?: string }).errorMessage).toBeUndefined();
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

	it("keeps uploaded images on the live user entry without duplicating message_end", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "describe this" }] },
		});
		applySessionEvent(state, {
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "describe this" }, imageRef("image/png")],
			},
		});

		expect(state.entries).toEqual([
			{
				kind: "user",
				text: "describe this",
				images: [reducedImage("image/png")],
				timestamp: undefined,
			},
		]);
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

	it("finalizes a live provider failure with partial content and terminal session state", () => {
		const state = makeState();
		applySessionEvent(state, { type: "agent_start" });
		applySessionEvent(state, { type: "message_start", message: { role: "assistant", model: "m1" } });
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_end",
			message: {
				role: "assistant",
				model: "m1",
				stopReason: "error",
				errorMessage: "upstream 503",
				content: [
					{ type: "thinking", thinking: "   \n" },
					{ type: "text", text: "partial answer" },
				],
			},
		});

		expect(state.entries[0]).toMatchObject({
			kind: "assistant",
			streaming: false,
			stopReason: "error",
			errorMessage: "upstream 503",
			blocks: [
				{ kind: "thinking", text: "   \n" },
				{ kind: "text", text: "partial answer" },
			],
		});
		expect(state.statusEntries).toContainEqual(
			expect.objectContaining({ key: "provider-error", text: "upstream 503", tone: "error" }),
		);
		expect(state.lastError).toBe("upstream 503");
		expect(state.needsAttention).toBe(true);
	});

	it("preserves live tool-split error ordering without duplicating lifecycle tool cards", () => {
		const state = makeState();
		applySessionEvent(state, { type: "message_start", message: { role: "assistant", model: "m1" } });
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		applySessionEvent(state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before tool" },
		});
		applySessionEvent(state, {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "/x" },
		});
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "file body" }] },
			isError: false,
		});

		applySessionEvent(state, {
			type: "message_end",
			message: {
				role: "assistant",
				model: "m1",
				stopReason: "error",
				errorMessage: "provider exploded",
				content: [
					{ type: "text", text: "before tool" },
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
					{ type: "thinking", thinking: "after thinking" },
					{ type: "text", text: "partial after tool" },
				],
			},
		});

		expect(state.entries.map((entry) => entry.kind)).toEqual(["assistant", "tool", "assistant"]);
		expect(state.entries[0]).toMatchObject({
			kind: "assistant",
			blocks: [{ kind: "text", text: "before tool" }],
		});
		expect(state.entries[0]).not.toHaveProperty("errorMessage");
		expect(state.entries[1]).toMatchObject({
			kind: "tool",
			toolCallId: "t1",
			status: "done",
			resultText: "file body",
		});
		expect(state.entries[2]).toMatchObject({
			kind: "assistant",
			streaming: false,
			stopReason: "error",
			errorMessage: "provider exploded",
			blocks: [
				{ kind: "thinking", text: "after thinking" },
				{ kind: "text", text: "partial after tool" },
			],
		});
		expect(state.entries.filter((entry) => entry.kind === "tool" && entry.toolCallId === "t1")).toHaveLength(1);
	});

	it("appends an error-only live message when message_start was absent", () => {
		const state = makeState();
		state.entries.push({ kind: "assistant", blocks: [{ kind: "text", text: "older" }], streaming: false });

		applySessionEvent(state, {
			type: "message_end",
			message: { role: "assistant", stopReason: "error", content: [] },
		});

		expect(state.entries).toHaveLength(2);
		expect(state.entries[1]).toMatchObject({
			kind: "assistant",
			blocks: [],
			stopReason: "error",
			errorMessage: "Unknown error",
		});
		expect(state.lastError).toBe("Unknown error");
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

	it("extracts image references from a live tool_execution_end alongside the text note", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "Read image file [image/png]" }, imageRef("image/png")] },
			isError: false,
		});
		expect(state.entries[0]).toMatchObject({
			kind: "tool",
			status: "done",
			resultText: "Read image file [image/png]",
			images: [reducedImage("image/png")],
		});
	});

	it("extracts image references from a live tool_execution_update", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			partialResult: { content: [imageRef("image/jpeg")] },
		});
		expect((state.entries[0] as { images?: unknown }).images).toEqual([reducedImage("image/jpeg")]);
	});

	for (const finalResult of [
		{ content: [{ type: "text", text: "text only now" }] },
		"plain string result",
		{ content: [] },
		{ content: [{ type: "image_reference", id: "bad", mimeType: "image/svg+xml", size: -1 }] },
	]) {
		it("clears stale images when a final content snapshot has no valid references", () => {
			const state = makeState();
			applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
			applySessionEvent(state, {
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "read",
				partialResult: { content: [imageRef("image/png")] },
			});
			expect((state.entries[0] as { images?: unknown }).images).toEqual([reducedImage("image/png")]);
			applySessionEvent(state, {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "read",
				result: finalResult,
				isError: false,
			});
			expect((state.entries[0] as { images?: unknown }).images).toBeUndefined();
		});
	}

	it("preserves prior images when the final event carries no result/content", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			partialResult: { content: [imageRef("image/png")] },
		});
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {},
			isError: false,
		});
		expect((state.entries[0] as { images?: unknown }).images).toEqual([reducedImage("image/png")]);
	});

	it("clears stale images when a later text-only update supersedes an image snapshot", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			partialResult: { content: [imageRef("image/png")] },
		});
		applySessionEvent(state, {
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			partialResult: { content: [{ type: "text", text: "text snapshot" }] },
		});
		expect(state.entries[0]).toMatchObject({ resultText: "text snapshot" });
		expect((state.entries[0] as { images?: unknown }).images).toBeUndefined();
	});

	it("leaves images undefined for text-only tool results", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "no images here" }] },
			isError: false,
		});
		expect((state.entries[0] as { images?: unknown }).images).toBeUndefined();
	});

	it("drops raw image bytes and malformed references", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {
				content: [
					{ type: "text", text: "note" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					{ type: "image_reference", id: "bad", mimeType: "image/svg+xml", size: 1 },
				],
			},
			isError: false,
		});
		expect((state.entries[0] as { images?: unknown }).images).toBeUndefined();
		expect(state.entries[0]).toMatchObject({ resultText: "note" });
	});

	it("keeps valid references while dropping invalid siblings", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {
				content: [
					{ type: "text", text: "note" },
					{ type: "image_reference", id: "bad", mimeType: "image/png", size: 1 },
					imageRef("image/png"),
				],
			},
			isError: false,
		});
		expect(state.entries[0]).toMatchObject({ resultText: "note", images: [reducedImage("image/png")] });
	});

	it("keeps multiple valid image references from a single tool result", () => {
		const state = makeState();
		applySessionEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		applySessionEvent(state, {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [imageRef("image/png"), imageRef("image/webp", SECOND_IMAGE_ID)] },
			isError: false,
		});
		expect((state.entries[0] as { images?: unknown }).images).toEqual([
			reducedImage("image/png"),
			reducedImage("image/webp", SECOND_IMAGE_ID),
		]);
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
		expect(state.statusEntries).toContainEqual(
			expect.objectContaining({
				key: "retry",
				text: "response truncated, retrying with larger budget (2/4)",
				tone: "warning",
			}),
		);
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

	it("does not duplicate a summary entry already present from snapshot hydration", () => {
		const state = makeState();
		state.entries = messagesToEntries([
			{ role: "compactionSummary", summary: "earlier work summarized", tokensBefore: 52410 },
		]);
		applySessionEvent(state, { type: "auto_compaction_start", reason: "threshold" });
		applySessionEvent(state, {
			type: "auto_compaction_end",
			result: { tokensBefore: 52410, summary: "earlier work summarized" },
			aborted: false,
			willRetry: false,
		});

		const summaries = state.entries.filter((e) => e.kind === "summary" && e.label === "compaction");
		expect(summaries).toHaveLength(1);
	});

	it("still appends a summary entry when an earlier compaction differs", () => {
		const state = makeState();
		state.entries = messagesToEntries([
			{ role: "compactionSummary", summary: "first compaction", tokensBefore: 1000 },
		]);
		applySessionEvent(state, { type: "auto_compaction_start", reason: "threshold" });
		applySessionEvent(state, {
			type: "auto_compaction_end",
			result: { tokensBefore: 2000, summary: "second compaction" },
			aborted: false,
			willRetry: false,
		});

		const summaries = state.entries.filter((e) => e.kind === "summary" && e.label === "compaction");
		expect(summaries).toHaveLength(2);
		expect(summaries[1]).toMatchObject({ text: "second compaction", tokensBefore: 2000 });
	});

	it("clears provisional provider state while overflow compaction recovers", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "context overflow",
				content: [{ type: "text", text: "partial" }],
			},
		});
		expect(state.lastError).toBe("context overflow");
		expect(state.needsAttention).toBe(true);

		applySessionEvent(state, { type: "auto_compaction_start", reason: "overflow" });

		expect(state.compacting).toBe(true);
		expect(state.lastError).toBeUndefined();
		expect(state.statusEntries).toEqual([
			expect.objectContaining({ key: "compaction", text: "compacting context…", tone: "info" }),
		]);
		expect(state.needsAttention).toBe(false);

		applySessionEvent(state, {
			type: "auto_compaction_end",
			errorMessage: "summarizer failed",
			aborted: false,
			willRetry: false,
		});
		expect(state.statusEntries).toContainEqual(
			expect.objectContaining({ key: "compaction-error", text: "summarizer failed", tone: "error" }),
		);
		expect(state.needsAttention).toBe(true);
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
		expect(state.statusEntries).toContainEqual(
			expect.objectContaining({ key: "compaction-error", text: "summarizer failed", tone: "error" }),
		);
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

	it("transitions provider errors through retry, success, and exhausted retry without duplicates", () => {
		const state = makeState();
		const failure = {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "provider unavailable",
				content: [{ type: "text", text: "partial" }],
			},
		};

		applySessionEvent(state, failure);
		applySessionEvent(state, { type: "agent_end", messages: [] });
		expect(state.statusEntries.filter((entry) => entry.key === "provider-error")).toHaveLength(1);

		applySessionEvent(state, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			errorMessage: "provider unavailable",
		});
		expect(state.lastError).toBeUndefined();
		expect(state.statusEntries).toEqual([expect.objectContaining({ key: "retry", tone: "warning" })]);
		expect(state.needsAttention).toBe(false);

		applySessionEvent(state, { type: "agent_start" });
		applySessionEvent(state, {
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] },
		});
		applySessionEvent(state, { type: "auto_retry_end", success: true, attempt: 1 });
		applySessionEvent(state, { type: "agent_end", messages: [] });
		expect(state.lastError).toBeUndefined();
		expect(state.statusEntries.some((entry) => entry.key === "provider-error")).toBe(false);
		expect(state.entries.filter((entry) => entry.kind === "assistant" && entry.stopReason === "error")).toHaveLength(
			1,
		);

		applySessionEvent(state, failure);
		applySessionEvent(state, {
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "provider unavailable",
		});
		expect(state.statusEntries.filter((entry) => entry.key === "provider-error")).toHaveLength(1);
		expect(state.lastError).toBe("provider unavailable");
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

	it("assigns distinct numeric IDs to repeated and new status occurrences", () => {
		const state = makeState();
		applySessionEvent(state, { type: "stream_retry", attempt: 1, maxAttempts: 3 });
		const firstRetry = state.statusEntries[0];
		applySessionEvent(state, { type: "length_retry", attempt: 2, maxAttempts: 4 });
		const secondRetry = state.statusEntries[0];
		applySessionEvent(state, { type: "parent_paused_for_background_agents", runningAgentCount: 1 });
		const paused = state.statusEntries.find((entry) => entry.key === "paused");

		expect(firstRetry).toMatchObject({ id: expect.any(Number), key: "retry" });
		expect(secondRetry).toMatchObject({ id: expect.any(Number), key: "retry" });
		expect(paused).toMatchObject({ id: expect.any(Number), key: "paused" });
		expect(new Set([firstRetry?.id, secondRetry?.id, paused?.id]).size).toBe(3);
	});
});

describe("syncCompactionStatusEntry", () => {
	it("creates the compaction status entry when compacting is true", () => {
		const state = makeState();
		state.compacting = true;
		syncCompactionStatusEntry(state);
		expect(state.statusEntries).toEqual([
			expect.objectContaining({ key: "compaction", text: "compacting context…", tone: "info" }),
		]);
	});

	it("keeps exactly one compaction status entry when called repeatedly", () => {
		const state = makeState();
		state.compacting = true;
		syncCompactionStatusEntry(state);
		syncCompactionStatusEntry(state);
		expect(state.statusEntries.filter((s) => s.key === "compaction")).toHaveLength(1);
	});

	it("re-exposes the entry after dismissal while still compacting", () => {
		const state = makeState();
		state.compacting = true;
		syncCompactionStatusEntry(state);
		const previous = state.statusEntries.find((s) => s.key === "compaction");
		previous!.dismissed = true;
		syncCompactionStatusEntry(state);
		const current = state.statusEntries.find((s) => s.key === "compaction");
		expect(current?.dismissed).toBeUndefined();
		expect(current?.id).not.toBe(previous!.id);
	});

	it("removes the compaction status entry when compacting is false", () => {
		const state = makeState();
		state.compacting = true;
		syncCompactionStatusEntry(state);
		state.compacting = false;
		syncCompactionStatusEntry(state);
		expect(state.statusEntries.some((s) => s.key === "compaction")).toBe(false);
	});

	it("leaves other status entries untouched", () => {
		const state = makeState();
		applySessionEvent(state, { type: "parent_paused_for_background_agents", runningAgentCount: 1 });
		state.compacting = true;
		syncCompactionStatusEntry(state);
		expect(state.statusEntries.map((s) => s.key).sort()).toEqual(["compaction", "paused"]);
	});
});

describe("pendingQuestionsReason", () => {
	const ask = (id: string, questionCount: number): ExtensionUiRequest => ({
		id,
		method: "ask",
		title: "Question",
		questions: Array.from({ length: questionCount }, (_, i) => ({ question: `Question ${i + 1}` })),
	});

	it("returns undefined when nothing is pending", () => {
		expect(pendingQuestionsReason([])).toBeUndefined();
	});

	it("returns undefined when a pending ask request carries no questions", () => {
		expect(pendingQuestionsReason([ask("a1", 0)])).toBeUndefined();
	});

	it("counts a single pending question in the singular", () => {
		expect(pendingQuestionsReason([ask("a1", 1)])).toBe("waiting for input — 1 question");
	});

	it("sums the total number of questions across pending ask requests", () => {
		expect(pendingQuestionsReason([ask("a1", 2), ask("a2", 1)])).toBe("waiting for input — 3 questions");
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

	it("resolveUiRequest removes an ask request by id and clears attention when the last one goes", () => {
		const state = makeState();
		applySessionEvent(state, { type: "extension_ui_request", id: "a1", method: "ask", title: "First" });
		applySessionEvent(state, { type: "extension_ui_request", id: "a2", method: "ask", title: "Second" });
		expect(state.uiRequests.map((r) => r.id)).toEqual(["a1", "a2"]);

		resolveUiRequest(state, "a1");
		expect(state.uiRequests.map((r) => r.id)).toEqual(["a2"]);
		expect(state.needsAttention).toBe(true);

		resolveUiRequest(state, "a2");
		expect(state.uiRequests).toHaveLength(0);
		expect(state.needsAttention).toBe(false);
	});

	it("handled events dismiss requests that timed out or aborted in the runtime", () => {
		const state = makeState();
		applySessionEvent(state, { type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });

		applySessionEvent(state, { type: "extension_ui_response_handled", id: "u1" });

		expect(state.uiRequests).toHaveLength(0);
		expect(state.needsAttention).toBe(false);
	});

	it("ask requests populate uiRequests with the questions[] array and set attention", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "a1",
			method: "ask",
			title: "Choose a database",
			questions: [
				{
					question: "Which persistence strategy?",
					title: "Storage",
					options: ["SQLite", "Postgres"],
					multiSelect: true,
					multiline: false,
					allowFreeText: true,
				},
			],
		});
		expect(state.uiRequests).toHaveLength(1);
		expect(state.uiRequests[0]).toMatchObject({
			id: "a1",
			method: "ask",
			title: "Choose a database",
			questions: [
				{
					question: "Which persistence strategy?",
					title: "Storage",
					options: ["SQLite", "Postgres"],
					multiSelect: true,
					allowFreeText: true,
				},
			],
		});
		expect(state.needsAttention).toBe(true);

		resolveUiRequest(state, "a1");
		expect(state.uiRequests).toHaveLength(0);
		expect(state.needsAttention).toBe(false);
	});

	it("parses multiple questions in a single ask request", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "a-multi",
			method: "ask",
			title: "Setup",
			questions: [
				{ question: "First?", options: ["A", "B"] },
				{ question: "Second?", multiline: true },
			],
		});
		expect(state.uiRequests[0]?.questions).toHaveLength(2);
		expect(state.uiRequests[0]?.questions?.[1]).toMatchObject({ question: "Second?", multiline: true });
	});

	it("defaults questions to an empty array when the ask event omits them", () => {
		const state = makeState();
		applySessionEvent(state, { type: "extension_ui_request", id: "a-empty", method: "ask", title: "Choose" });
		expect(state.uiRequests[0]?.questions).toEqual([]);
	});

	it("extracts the numeric ask timeout and absolute deadline onto the ui request", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "a-timeout",
			method: "ask",
			title: "Choose",
			questions: [{ question: "Which?", options: ["a", "b"] }],
			timeout: 30_000,
			expiresAt: 1_030_000,
		});
		// The deadline keeps the visible countdown aligned with the authoritative
		// runtime timer when this request is restored after a reload or resync.
		expect(state.uiRequests[0]).toMatchObject({ timeout: 30_000, expiresAt: 1_030_000 });
	});

	it("ignores non-numeric ask timeout metadata (guards against malformed events)", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "extension_ui_request",
			id: "a-bad-timeout",
			method: "ask",
			title: "Choose",
			questions: [{ question: "Which?", options: ["a"] }],
			timeout: "soon",
			expiresAt: "later",
		});
		expect(state.uiRequests[0]?.timeout).toBeUndefined();
		expect(state.uiRequests[0]?.expiresAt).toBeUndefined();
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
	it("retains failed arbitration metadata without changing the requested agent identity", () => {
		const state = makeState();
		applySessionEvent(state, {
			type: "background_agent_start",
			agentId: "failed-route",
			agentType: "Explore",
			taskSummary: "look",
		});
		applySessionEvent(state, {
			type: "subagent_arbitration",
			agentId: "failed-route",
			status: "failure",
			proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
			final: null,
			changed: [],
			errorCode: "invalid_guide",
			errorMessage: "Routing guide coverage is stale.",
			rawResponse: "RAW ARBITER MODEL OUTPUT",
		});

		expect(state.backgroundAgents["failed-route"]).toMatchObject({
			agentType: "Explore",
			arbitrations: [
				{
					status: "failure",
					final: null,
					changed: [],
					errorCode: "invalid_guide",
					errorMessage: "Routing guide coverage is stale.",
				},
			],
		});
		expect(JSON.stringify(state.backgroundAgents["failed-route"])).not.toContain("RAW ARBITER MODEL OUTPUT");
	});

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

		applySessionEvent(state, {
			type: "subagent_arbitration",
			agentId: "bg1",
			status: "success",
			proposed: { agent: "Explore", model: "provider/frontier", thinking: "high" },
			final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" },
			changed: ["agent", "model", "thinking"],
		});
		expect(state.backgroundAgents.bg1).toMatchObject({
			agentType: "feature-dev",
			arbitrations: [
				{
					status: "success",
					final: { agent: "feature-dev", model: "provider/cheap", thinking: "low" },
				},
			],
		});

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
