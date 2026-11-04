import type { AssistantMessage, Model } from "@dreb/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.js";

const originalFetch = global.fetch;

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};

const usage: AssistantMessage["usage"] = {
	input: 12,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ERROR_MESSAGE =
	"Request declined by the model's safety filter (category: cyber): This request was declined because it could enable cyber harm.";

function mockProxy(events: ProxyAssistantMessageEvent[]): void {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
	global.fetch = vi.fn(
		async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
	) as typeof fetch;
}

async function runProxy(): Promise<AssistantMessage> {
	const stream = streamProxy(
		model,
		{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
		{ authToken: "token", proxyUrl: "https://proxy.example.invalid" },
	);
	for await (const _event of stream) {
		// Drain events; the final message is the result.
	}
	return stream.result();
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("streamProxy refusals", () => {
	it("carries the refusal details from the proxy error event onto the message", async () => {
		mockProxy([
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
			{
				type: "error",
				reason: "error",
				errorMessage: ERROR_MESSAGE,
				refusal: {
					category: "cyber",
					explanation: "This request was declined because it could enable cyber harm.",
				},
				usage,
			},
		]);

		const result = await runProxy();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(ERROR_MESSAGE);
		expect(result.refusal).toEqual({
			category: "cyber",
			explanation: "This request was declined because it could enable cyber harm.",
		});
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.usage).toEqual(usage);
	});

	it("leaves refusal unset for other proxy errors", async () => {
		mockProxy([{ type: "start" }, { type: "error", reason: "error", errorMessage: "529 overloaded", usage }]);

		const result = await runProxy();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("529 overloaded");
		expect(result).not.toHaveProperty("refusal");
	});
});
