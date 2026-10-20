import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";
import { isLiveApiEnabled } from "./live-api.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number };
	output_config?: { effort?: string };
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(model: Model<"anthropic-messages">): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<"anthropic-messages">): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it.each(["claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"] as const)(
		"sends thinking.type=disabled for adaptive model %s when thinking is off",
		async (id) => {
			const payload = await capturePayload(getModel("anthropic", id));

			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.output_config).toBeUndefined();
		},
	);

	it("sends thinking.type=between_tools for Sonnet 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-5-5"));

		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends no thinking field and no effort to Opus 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"));

		expect(payload).not.toHaveProperty("thinking");
		expect(payload).not.toHaveProperty("output_config");
	});

	it.each([
		["claude-opus-4.8", { type: "disabled" }],
		["claude-haiku-5.5", { type: "disabled" }],
		["claude-sonnet-5.5", { type: "between_tools" }],
	] as const)("sends the native off config to Copilot %s", async (id, thinking) => {
		const payload = await capturePayload(getModel("github-copilot", id));

		expect(payload.thinking).toEqual(thinking);
		expect(payload.output_config).toBeUndefined();
	});

	it("sends no thinking field to Copilot Opus 5.5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("github-copilot", "claude-opus-5.5"));

		expect(payload).not.toHaveProperty("thinking");
		expect(payload).not.toHaveProperty("output_config");
	});
});

describe.skipIf(!isLiveApiEnabled() || !process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(getModel("anthropic", "claude-sonnet-4-5"));

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
