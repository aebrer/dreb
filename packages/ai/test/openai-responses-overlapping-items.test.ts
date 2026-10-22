import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

// Offline regressions for overlapping Responses output items: events must be
// routed by item id, never to "the most recently added item".

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "test-model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* toStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
}

async function run(events: unknown[]): Promise<{ output: AssistantMessage; emitted: AssistantMessageEvent[] }> {
	const output = makeOutput();
	const stream = new AssistantMessageEventStream();
	const emitted: AssistantMessageEvent[] = [];
	const originalPush = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		// Snapshot so later mutation of shared objects can't hide what was emitted.
		emitted.push(structuredClone(event));
		originalPush(event);
	};
	await processResponsesStream(toStream(events), output, stream, model);
	return { output, emitted };
}

const completed = {
	type: "response.completed",
	response: {
		id: "resp_1",
		status: "completed",
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
	},
};

const reasoningItem = (id: string) => ({ type: "reasoning", id, summary: [] });
const messageItem = (id: string, text?: string) => ({
	type: "message",
	id,
	role: "assistant",
	status: text === undefined ? "in_progress" : "completed",
	content: text === undefined ? [] : [{ type: "output_text", text, annotations: [] }],
});
const fnItem = (id: string, callId: string, name: string, args = "") => ({
	type: "function_call",
	id,
	call_id: callId,
	name,
	arguments: args,
});

describe("processResponsesStream overlapping output items", () => {
	it("keeps an answer whose message opened before a reasoning item and completed after it", async () => {
		const { output, emitted } = await run([
			{ type: "response.output_item.added", output_index: 0, item: messageItem("msg_M") },
			{ type: "response.output_item.added", output_index: 1, item: reasoningItem("rs_R") },
			{ type: "response.output_item.done", output_index: 1, item: reasoningItem("rs_R") },
			{ type: "response.output_item.done", output_index: 0, item: messageItem("msg_M", "425") },
			completed,
		]);

		expect(output.content.map((b) => b.type)).toEqual(["text", "thinking"]);
		expect(output.content[0]).toMatchObject({ type: "text", text: "425" });
		expect(output.stopReason).toBe("stop");

		const textEnd = emitted.find((e) => e.type === "text_end");
		expect(textEnd).toMatchObject({ type: "text_end", contentIndex: 0, content: "425" });
		const thinkingEnd = emitted.find((e) => e.type === "thinking_end");
		expect(thinkingEnd).toMatchObject({ contentIndex: 1 });
	});

	it("keeps each overlapping tool call's own id, name and arguments", async () => {
		const { output, emitted } = await run([
			{ type: "response.output_item.added", output_index: 0, item: fnItem("fc_A", "call_A", "lookup_city") },
			{ type: "response.function_call_arguments.delta", item_id: "fc_A", output_index: 0, delta: '{"city":"Oslo"}' },
			{ type: "response.output_item.added", output_index: 1, item: fnItem("fc_B", "call_B", "lookup_element") },
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", output_index: 1, delta: '{"symbol":"Fe"}' },
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_A",
				output_index: 0,
				arguments: '{"city":"Oslo"}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: fnItem("fc_A", "call_A", "lookup_city", '{"city":"Oslo"}'),
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_B",
				output_index: 1,
				arguments: '{"symbol":"Fe"}',
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: fnItem("fc_B", "call_B", "lookup_element", '{"symbol":"Fe"}'),
			},
			completed,
		]);

		expect(output.content).toEqual([
			{ type: "toolCall", id: "call_A|fc_A", name: "lookup_city", arguments: { city: "Oslo" } },
			{ type: "toolCall", id: "call_B|fc_B", name: "lookup_element", arguments: { symbol: "Fe" } },
		]);
		expect(output.stopReason).toBe("toolUse");

		const ends = emitted.filter((e) => e.type === "toolcall_end");
		expect(ends).toHaveLength(2);
		expect(ends[0]).toMatchObject({
			contentIndex: 0,
			toolCall: { id: "call_A|fc_A", name: "lookup_city", arguments: { city: "Oslo" } },
		});
		expect(ends[1]).toMatchObject({
			contentIndex: 1,
			toolCall: { id: "call_B|fc_B", name: "lookup_element", arguments: { symbol: "Fe" } },
		});
	});

	it("routes interleaved argument deltas to their own tool calls", async () => {
		const { output, emitted } = await run([
			{ type: "response.output_item.added", output_index: 0, item: fnItem("fc_A", "call_A", "lookup_city") },
			{ type: "response.output_item.added", output_index: 1, item: fnItem("fc_B", "call_B", "lookup_element") },
			{ type: "response.function_call_arguments.delta", item_id: "fc_A", delta: '{"city":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", delta: '{"symbol":' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_A", delta: '"Oslo"}' },
			{ type: "response.function_call_arguments.delta", item_id: "fc_B", delta: '"Fe"}' },
			{ type: "response.output_item.done", item: fnItem("fc_A", "call_A", "lookup_city") },
			{ type: "response.output_item.done", item: fnItem("fc_B", "call_B", "lookup_element") },
			completed,
		]);

		expect(output.content).toEqual([
			{ type: "toolCall", id: "call_A|fc_A", name: "lookup_city", arguments: { city: "Oslo" } },
			{ type: "toolCall", id: "call_B|fc_B", name: "lookup_element", arguments: { symbol: "Fe" } },
		]);
		const deltaIndices = emitted.filter((e) => e.type === "toolcall_delta").map((e) => e.contentIndex);
		expect(deltaIndices).toEqual([0, 1, 0, 1]);
	});

	it("routes events without item_id when exactly one item is open", async () => {
		const { output } = await run([
			{ type: "response.output_item.added", item: messageItem("msg_1") },
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hello" },
			{ type: "response.output_item.done", item: messageItem("msg_1", "Hello") },
			completed,
		]);
		expect(output.content).toMatchObject([{ type: "text", text: "Hello" }]);
	});

	it("keeps a sequential reasoning → message → tool flow unchanged", async () => {
		const { output, emitted } = await run([
			{ type: "response.output_item.added", item: reasoningItem("rs_1") },
			{
				type: "response.output_item.done",
				item: { ...reasoningItem("rs_1"), summary: [{ type: "summary_text", text: "think" }] },
			},
			{ type: "response.output_item.added", item: messageItem("msg_1") },
			{ type: "response.content_part.added", item_id: "msg_1", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
			{ type: "response.output_item.done", item: messageItem("msg_1", "Hi") },
			{ type: "response.output_item.added", item: fnItem("fc_1", "call_1", "read") },
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"a"}' },
			{ type: "response.output_item.done", item: fnItem("fc_1", "call_1", "read", '{"path":"a"}') },
			completed,
		]);
		expect(output.content).toMatchObject([
			{ type: "thinking", thinking: "think" },
			{ type: "text", text: "Hi" },
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a" } },
		]);
		expect("partialJson" in output.content[2]).toBe(false);
		expect(emitted.map((e) => e.type)).toEqual([
			"thinking_start",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
	});

	it("throws when an event without item_id is ambiguous", async () => {
		await expect(
			run([
				{ type: "response.output_item.added", item: fnItem("fc_A", "call_A", "a") },
				{ type: "response.output_item.added", item: fnItem("fc_B", "call_B", "b") },
				{ type: "response.function_call_arguments.delta", delta: "{}" },
				completed,
			]),
		).rejects.toThrow(/no item_id while 2 output items are open/);
	});

	it("throws when an event references an unknown item", async () => {
		await expect(
			run([
				{ type: "response.output_item.added", item: fnItem("fc_A", "call_A", "a") },
				{ type: "response.function_call_arguments.done", item_id: "fc_X", arguments: "{}" },
				completed,
			]),
		).rejects.toThrow(/unknown or already completed item "fc_X"/);
	});

	it("throws when an item completes without having been added", async () => {
		await expect(
			run([
				{ type: "response.output_item.added", item: messageItem("msg_1") },
				{ type: "response.output_item.done", item: messageItem("msg_2", "x") },
				completed,
			]),
		).rejects.toThrow(/unknown or already completed item "msg_2"/);
	});
});
