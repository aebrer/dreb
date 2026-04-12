import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	streamParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	const fakeStream = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "message_start",
				message: {
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			};
			yield {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			};
		},
		finalMessage: async () => ({
			usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
		}),
	};

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			stream: (params: Record<string, unknown>) => {
				mockState.streamParams = params;
				return fakeStream;
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Third-party Anthropic-compatible endpoints", () => {
	const context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }],
	};

	it("sends minimal headers for third-party endpoints (no beta headers, no dangerouslyAllowBrowser)", async () => {
		const { getModel } = await import("../src/models.js");
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		const model = getModel("kimi-coding", "k2p5");
		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).not.toContain("anthropic.com");

		const s = streamAnthropic(model!, context, { apiKey: "test-kimi-key" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const opts = mockState.constructorOpts!;
		expect(opts).toBeDefined();

		// Should use the API key directly (not Bearer/OAuth)
		expect(opts.apiKey).toBe("test-kimi-key");
		expect(opts.authToken).toBeUndefined();

		// Should NOT have dangerouslyAllowBrowser
		expect(opts.dangerouslyAllowBrowser).toBeUndefined();

		// Headers should be minimal — no Anthropic-specific beta headers
		const headers = opts.defaultHeaders as Record<string, string>;
		expect(headers.accept).toBe("application/json");
		expect(headers["anthropic-beta"]).toBeUndefined();
		expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
	});

	it("includes beta headers and dangerouslyAllowBrowser for first-party Anthropic endpoints", async () => {
		const { getModel } = await import("../src/models.js");
		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();

		const s = streamAnthropic(model!, context, { apiKey: "sk-test-key" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const opts = mockState.constructorOpts!;
		expect(opts).toBeDefined();

		// First-party should have dangerouslyAllowBrowser
		expect(opts.dangerouslyAllowBrowser).toBe(true);

		// Should have beta headers
		const headers = opts.defaultHeaders as Record<string, string>;
		expect(headers["anthropic-beta"]).toContain("fine-grained-tool-streaming");
		expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
	});
});
