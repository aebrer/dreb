import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";

function mockDoneStream() {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
}

describe("openai-responses github-copilot defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		mockDoneStream();

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("streamSimple applies reasoning defaults without synthetic one-token cap", async () => {
		const model: Model<"openai-responses"> = {
			id: "gpt-5.5",
			name: "gpt-5.5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 100000,
		};
		let capturedPayload: { max_output_tokens?: unknown } | undefined;

		mockDoneStream();

		const stream = streamSimple(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				reasoning: "xhigh",
				onPayload: (payload) => {
					capturedPayload = payload as { max_output_tokens?: unknown };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "xhigh", summary: "auto" },
			max_output_tokens: 32000,
			include: ["reasoning.encrypted_content"],
		});
		expect(capturedPayload?.max_output_tokens).not.toBe(1);
	});
});
