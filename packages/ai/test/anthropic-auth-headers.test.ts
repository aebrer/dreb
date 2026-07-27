import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, StreamOptions } from "../src/types.js";

const originalFetch = global.fetch;

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function createModel(
	baseUrl: string,
	overrides: Partial<Model<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}

function createSseResponse(): Response {
	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "test-model",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	const body = `${events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequestHeaders(model: Model<"anthropic-messages">, options: StreamOptions): Promise<Headers> {
	let captured: Headers | undefined;
	global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured = new Headers(init?.headers);
		return createSseResponse();
	}) as typeof fetch;

	const stream = streamAnthropic(model, context, options);
	const errors: string[] = [];
	for await (const event of stream) {
		if (event.type === "error") errors.push(event.error.errorMessage ?? "unknown error");
	}

	expect(errors).toEqual([]);
	expect(captured).toBeDefined();
	return captured!;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Anthropic final auth headers", () => {
	it("sends only x-api-key for a default third-party endpoint despite ambient Bearer auth", async () => {
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-that-must-not-leak");

		const headers = await captureRequestHeaders(createModel("https://proxy.example.com"), {
			apiKey: "configured-api-key",
		});

		expect(headers.get("x-api-key")).toBe("configured-api-key");
		expect(headers.has("authorization")).toBe(false);
	});

	it("sends only the request-time Bearer credential and ignores a stale model header", async () => {
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-that-must-not-leak");
		const model = createModel("https://proxy.example.com", {
			authMode: "bearer",
			headers: {
				authorization: "Bearer stale-load-time-key",
				"x-custom-header": "preserved",
			},
		});

		const headers = await captureRequestHeaders(model, { apiKey: "request-time-key" });

		expect(headers.get("authorization")).toBe("Bearer request-time-key");
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.get("x-custom-header")).toBe("preserved");
	});

	it("does not mix an ambient Bearer token into first-party API-key auth", async () => {
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token-that-must-not-leak");

		const headers = await captureRequestHeaders(createModel("https://api.anthropic.com"), {
			apiKey: "configured-api-key",
		});

		expect(headers.get("x-api-key")).toBe("configured-api-key");
		expect(headers.has("authorization")).toBe(false);
	});
});
