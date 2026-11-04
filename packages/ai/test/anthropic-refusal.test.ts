import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.js";

// Drives the real @anthropic-ai/sdk client against a faux SSE response. The pinned SDK
// types do not declare `stop_details`, so this also proves the SDK's stream iterator passes
// the undeclared field through to the provider at runtime.

const originalFetch = global.fetch;

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test-provider",
	baseUrl: "https://proxy.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const CYBER_EXPLANATION = "This request was declined because it could enable cyber harm.";

type SseEvent = { event: string; data: Record<string, unknown> };

function messageStart(): SseEvent {
	return {
		event: "message_start",
		data: {
			type: "message_start",
			message: {
				id: "msg_refusal",
				type: "message",
				role: "assistant",
				model: "test-model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 412, output_tokens: 0 },
			},
		},
	};
}

function partialText(text: string): SseEvent[] {
	return [
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
	];
}

function messageDelta(delta: Record<string, unknown>, outputTokens = 0): SseEvent {
	return {
		event: "message_delta",
		data: {
			type: "message_delta",
			delta: { stop_sequence: null, ...delta },
			usage: { output_tokens: outputTokens },
		},
	};
}

function sseBody(events: SseEvent[]): string {
	const all = [...events, { event: "message_stop", data: { type: "message_stop" } }];
	return `${all.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join("\n\n")}\n\n`;
}

function mockSse(events: SseEvent[]): void {
	const body = sseBody(events);
	global.fetch = vi.fn(
		async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
	) as typeof fetch;
}

async function run(events: SseEvent[]): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	mockSse(events);
	const stream = streamAnthropic(model, context, { apiKey: "test-key" });
	const seen: AssistantMessageEvent[] = [];
	for await (const event of stream) seen.push(event);
	return { events: seen, result: await stream.result() };
}

function terminal(events: AssistantMessageEvent[]): AssistantMessageEvent {
	const last = events.at(-1);
	if (!last) throw new Error("stream produced no events");
	return last;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("Anthropic refusals", () => {
	it("reports the stop_details category and explanation instead of an unknown error", async () => {
		const { events, result } = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "cyber", explanation: CYBER_EXPLANATION },
			}),
		]);

		const end = terminal(events);
		expect(end.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(
			`Request declined by the model's safety filter (category: cyber): ${CYBER_EXPLANATION}`,
		);
		expect(result.refusal).toEqual({ category: "cyber", explanation: CYBER_EXPLANATION });
		expect(result.usage.input).toBe(412);
	});

	it("still reports a refusal when stop_details is missing", async () => {
		const { result } = await run([messageStart(), messageDelta({ stop_reason: "refusal" })]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request declined by the model's safety filter.");
		expect(result.refusal).toEqual({});
	});

	it("omits null category and explanation", async () => {
		const { result } = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: null, explanation: null },
			}),
		]);

		expect(result.errorMessage).toBe("Request declined by the model's safety filter.");
		expect(result.refusal).toEqual({});
	});

	it("formats a category without an explanation", async () => {
		const { result } = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "bio", explanation: null },
			}),
		]);

		expect(result.errorMessage).toBe("Request declined by the model's safety filter (category: bio).");
		expect(result.refusal).toEqual({ category: "bio" });
	});

	it("formats an explanation without a category", async () => {
		const { result } = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: null, explanation: "Declined under the usage policy." },
			}),
		]);

		expect(result.errorMessage).toBe(
			"Request declined by the model's safety filter: Declined under the usage policy.",
		);
		expect(result.refusal).toEqual({ explanation: "Declined under the usage policy." });
	});

	it.each([
		["a string", "cyber"],
		["an array", ["cyber"]],
		["non-string fields", { type: "refusal", category: 42, explanation: { text: "nested" } }],
		["blank strings", { type: "refusal", category: "  ", explanation: "" }],
	])("ignores malformed stop_details (%s)", async (_label, stopDetails) => {
		const { result } = await run([
			messageStart(),
			messageDelta({ stop_reason: "refusal", stop_details: stopDetails }),
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request declined by the model's safety filter.");
		expect(result.refusal).toEqual({});
	});

	it("reports the proxy 'sensitive' stop reason with the same wording and no category", async () => {
		const { events, result } = await run([messageStart(), messageDelta({ stop_reason: "sensitive" })]);

		expect(terminal(events).type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request declined by the model's safety filter.");
		expect(result.refusal).toEqual({});
	});

	it("keeps partial output and usage from a mid-stream refusal", async () => {
		const { events, result } = await run([
			messageStart(),
			...partialText("Here is how to"),
			messageDelta(
				{
					stop_reason: "refusal",
					stop_details: { type: "refusal", category: "cyber", explanation: CYBER_EXPLANATION },
				},
				7,
			),
		]);

		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		expect(terminal(events).type).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "Here is how to" }]);
		expect(result.usage.output).toBe(7);
		expect(result.refusal).toEqual({ category: "cyber", explanation: CYBER_EXPLANATION });
	});

	it("keeps captured details when a later message_delta omits stop_details", async () => {
		const { result } = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "cyber", explanation: CYBER_EXPLANATION },
			}),
			messageDelta({ stop_reason: null }, 3),
		]);

		expect(result.refusal).toEqual({ category: "cyber", explanation: CYBER_EXPLANATION });
		expect(result.usage.output).toBe(3);
	});

	it("decides the outcome from the final stop reason received", async () => {
		const replaced = await run([
			messageStart(),
			messageDelta({
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "cyber", explanation: CYBER_EXPLANATION },
			}),
			messageDelta({ stop_reason: "end_turn", stop_details: null }),
		]);
		expect(terminal(replaced.events).type).toBe("done");
		expect(replaced.result.stopReason).toBe("stop");
		expect(replaced.result).not.toHaveProperty("refusal");

		const refusedLast = await run([
			messageStart(),
			messageDelta({ stop_reason: "end_turn" }),
			messageDelta({ stop_reason: "refusal" }),
		]);
		expect(terminal(refusedLast.events).type).toBe("error");
		expect(refusedLast.result.stopReason).toBe("error");
		expect(refusedLast.result.errorMessage).toBe("Request declined by the model's safety filter.");
		expect(refusedLast.result.refusal).toEqual({});
	});

	it("does not mark a normal end_turn with null stop_details as a refusal", async () => {
		const { events, result } = await run([
			messageStart(),
			...partialText("Hi!"),
			messageDelta({ stop_reason: "end_turn", stop_details: null }, 2),
		]);

		expect(terminal(events).type).toBe("done");
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result).not.toHaveProperty("refusal");
	});

	it("does not attach refusal details to a request aborted while the refusal arrives", async () => {
		const abort = new AbortController();
		const bytes = new TextEncoder().encode(
			sseBody([
				messageStart(),
				messageDelta({
					stop_reason: "refusal",
					stop_details: { type: "refusal", category: "cyber", explanation: CYBER_EXPLANATION },
				}),
			]),
		);
		global.fetch = vi.fn(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
				},
				// Runs once the SDK has taken the refusal chunk and asks for more.
				pull(controller) {
					abort.abort();
					controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;

		const stream = streamAnthropic(model, context, { apiKey: "test-key", signal: abort.signal });
		const result = await stream.result();

		expect(result.stopReason).toBe("aborted");
		expect(result).not.toHaveProperty("refusal");
	});

	it("does not mark a stream that dropped before message_delta as a refusal", async () => {
		const { result } = await run([messageStart(), ...partialText("partial")]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Stream ended without message_delta — connection likely dropped");
		expect(result).not.toHaveProperty("refusal");
	});
});
