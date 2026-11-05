import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { isContextOverflow, isOutputLimitExhaustion } from "../src/utils/overflow.js";

const LENGTH_EXHAUSTED_ERROR = "Response truncated at the configured output token limit after 3 attempts";

function createErrorMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 90,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: LENGTH_EXHAUSTED_ERROR,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("successful responses exceeding the configured input window", () => {
	function successfulMessage(input: number, cacheRead: number, cacheWrite: number): AssistantMessage {
		return createErrorMessage({
			stopReason: "stop",
			errorMessage: undefined,
			usage: {
				...createErrorMessage().usage,
				input,
				cacheRead,
				cacheWrite,
				output: 158,
				totalTokens: input + cacheRead + cacheWrite + 158,
			},
		});
	}

	it.each([
		[568044, 0, 0],
		[2, 568042, 0],
		[2, 0, 568042], // Copilot Opus 4.8 live response, 2026-09-08
		[2, 100000, 100000],
	])("counts input=%i, cacheRead=%i, cacheWrite=%i", (input, cacheRead, cacheWrite) => {
		expect(isContextOverflow(successfulMessage(input, cacheRead, cacheWrite), 200000)).toBe(true);
	});

	it.each([199999, 200000])("does not count output toward input overflow at %i input tokens", (inputTokens) => {
		expect(isContextOverflow(successfulMessage(2, 100000, inputTokens - 100002), 200000)).toBe(false);
	});

	it("requires a configured window", () => {
		expect(isContextOverflow(successfulMessage(2, 0, 568042))).toBe(false);
	});

	it.each(["error", "aborted", "length", "toolUse"] as const)(
		"does not classify %s as a successful input overflow",
		(stopReason) => {
			const message = successfulMessage(2, 0, 568042);
			expect(isContextOverflow({ ...message, stopReason, errorMessage: "unrelated error" }, 200000)).toBe(false);
		},
	);
});

describe("context-filled length exhaustion detection", () => {
	it("classifies exhausted length retries at the context boundary as overflow", () => {
		expect(isContextOverflow(createErrorMessage(), 100)).toBe(true);
	});

	it("classifies exhausted length retries above the context boundary as overflow", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				totalTokens: 101,
			},
		});
		expect(isContextOverflow(message, 100)).toBe(true);
	});

	it("uses usage components when totalTokens is unavailable", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				input: 80,
				output: 10,
				cacheRead: 10,
				totalTokens: 0,
			},
		});
		expect(isContextOverflow(message, 100)).toBe(true);
	});

	it("classifies exhaustion when the configured output could not fit beside the recorded input", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				input: 60,
				output: 10,
				totalTokens: 70,
			},
		});
		expect(isContextOverflow(message, 100, { maxOutputTokens: 50 })).toBe(true);
	});

	it("uses estimated input when the provider omitted input usage", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				input: 0,
				output: 10,
				totalTokens: 10,
			},
		});
		expect(isContextOverflow(message, 100, { maxOutputTokens: 50, estimatedInputTokens: 60 })).toBe(true);
	});

	it("keeps genuine output-budget exhaustion below the context boundary", () => {
		const message = createErrorMessage({
			usage: {
				...createErrorMessage().usage,
				input: 20,
				output: 10,
				totalTokens: 30,
			},
		});
		expect(isContextOverflow(message, 100, { maxOutputTokens: 50 })).toBe(false);
		expect(isOutputLimitExhaustion(message)).toBe(true);
	});

	it("recognizes a preserved provider context detail", () => {
		const message = createErrorMessage({
			errorMessage: `${LENGTH_EXHAUSTED_ERROR}\nProvider detail: model_context_window_exceeded`,
		});
		expect(isContextOverflow(message, 1000, { maxOutputTokens: 50 })).toBe(true);
	});

	it("requires the configured context window", () => {
		expect(isContextOverflow(createErrorMessage())).toBe(false);
	});

	it("does not classify unrelated high-usage errors", () => {
		expect(isContextOverflow(createErrorMessage({ errorMessage: "529 overloaded" }), 100)).toBe(false);
	});
});

describe("GitHub Copilot overflow errors", () => {
	it("classifies a 413 Request Entity Too Large as context overflow", () => {
		expect(isContextOverflow(createErrorMessage({ errorMessage: "413 Request Entity Too Large\n" }))).toBe(true);
	});

	it("does not classify unrelated 4xx errors as overflow", () => {
		expect(isContextOverflow(createErrorMessage({ errorMessage: "403 Forbidden" }))).toBe(false);
	});
});

describe("request-size rejections", () => {
	// Reported verbatim: a LiteLLM proxy in front of Amazon Bedrock, reached through the
	// Anthropic SDK, which formats a body without a top-level `message` as `${status} ${JSON}`.
	const LITELLM_BEDROCK_INPUT_TOO_LONG = String.raw`400 {"err_msg":"litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - {\"message\":\"Input is too long.\"}\nmodel=claude-opus-5-5. context_window_fallbacks=None. fallbacks=None.\n\nSet 'context_window_fallback' - https://docs.litellm.ai/docs/routing model","err_code":"BAD_REQUEST","status_code":400}`;

	const ANTHROPIC_REQUEST_TOO_LARGE = `413 ${JSON.stringify({
		type: "error",
		error: { type: "request_too_large", message: "Request exceeds the maximum allowed number of bytes." },
	})}`;

	const NGINX_413_PAGE =
		"413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

	it.each([
		["the reported LiteLLM proxy rejection of a Bedrock request", LITELLM_BEDROCK_INPUT_TOO_LONG],
		["Bedrock's bare wording", "Input is too long."],
		["Bedrock's bare wording from an in-stream validation exception", "Validation error: Input is too long."],
		["Bedrock's model wording", "Validation error: Input is too long for requested model."],
		[
			"LiteLLM's exception as an OpenAI-compatible proxy surfaces it",
			'400 litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - {"message":"Input is too long."}',
		],
		[
			"LiteLLM's exception wrapping another backend",
			"400 litellm.ContextWindowExceededError: litellm.BadRequestError: OllamaException - upstream rejected the request",
		],
		["Anthropic's byte cap through the Anthropic SDK", ANTHROPIC_REQUEST_TOO_LARGE],
		[
			"Anthropic's byte cap through an OpenAI-compatible proxy",
			"413 Request exceeds the maximum allowed number of bytes.",
		],
		["a gateway 413 Payload Too Large", "413 Payload Too Large"],
		["a gateway 413 Content Too Large", "413 Content Too Large"],
		["a gateway 413 Request Entity Too Large", "413 Request Entity Too Large"],
		["nginx's multi-line HTML 413 page", NGINX_413_PAGE],
		["a 413 reported after a wrapper prefix", "got status: 413 Payload Too Large."],
	])("classifies %s as overflow", (_label, errorMessage) => {
		expect(isContextOverflow(createErrorMessage({ errorMessage }))).toBe(true);
	});

	it("never classifies a refusal as overflow, even when it reads like a size rejection", () => {
		const explanation = "Input is too long to review safely (request_too_large).";
		const refusal = createErrorMessage({
			errorMessage: `Request declined by the model's safety filter: ${explanation}`,
			refusal: { explanation },
		});
		expect(isContextOverflow(refusal, 100)).toBe(false);
	});

	it.each([
		[
			"Groq's per-minute token limit (413)",
			"413 Request too large for model `llama-3.3-70b-versatile` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 20000, please reduce your message size and try again.",
		],
		[
			"OpenAI's per-minute token limit",
			"429 Request too large for gpt-4o in organization org-test on tokens per min (TPM): Limit 30000, Requested 50000. The input or output tokens must be reduced in order to run successfully. Visit https://platform.openai.com/account/rate-limits to learn more.",
		],
		[
			"Anthropic's rate limit",
			`429 ${JSON.stringify({
				type: "error",
				error: {
					type: "rate_limit_error",
					message: "Number of request tokens has exceeded your per-minute rate limit",
				},
			})}`,
		],
		["an overload", "529 overloaded"],
		["a non-413 status that mentions a large payload", '400 Bad Request: payload too large for field "metadata"'],
	])("does not classify %s as overflow", (_label, errorMessage) => {
		expect(isContextOverflow(createErrorMessage({ errorMessage }))).toBe(false);
	});

	it.each(["400 status code (no body)", "413 status code (no body)"])(
		"still classifies Cerebras' bodiless %s as overflow",
		(errorMessage) => {
			expect(isContextOverflow(createErrorMessage({ errorMessage }))).toBe(true);
		},
	);
});

describe("throttling errors", () => {
	// Amazon Bedrock's per-minute token quota. Its text matches the generic "too many tokens"
	// fallback, but waiting clears it and compacting does not.
	const BEDROCK_TOKEN_THROTTLE = "Too many tokens, please wait before trying again.";

	it.each([
		["from the stream", `Throttling error: ${BEDROCK_TOKEN_THROTTLE}`],
		["as an SDK exception", BEDROCK_TOKEN_THROTTLE],
		[
			"through a LiteLLM proxy",
			`429 litellm.RateLimitError: BedrockException - {"message":"${BEDROCK_TOKEN_THROTTLE}"}`,
		],
		["with the AWS exception name", `ThrottlingException: ${BEDROCK_TOKEN_THROTTLE}`],
	])("does not classify Bedrock's token throttle %s as overflow", (_label, errorMessage) => {
		expect(isContextOverflow(createErrorMessage({ errorMessage }), 200000)).toBe(false);
	});

	it("still classifies a non-throttle 'too many tokens' error as overflow", () => {
		const errorMessage =
			"400 too many tokens: total number of tokens in the prompt cannot exceed 4081 - received 4502";
		expect(isContextOverflow(createErrorMessage({ errorMessage }))).toBe(true);
	});
});

describe("safety refusals", () => {
	const OVERFLOW_LOOKING_REFUSAL =
		"Request declined by the model's safety filter: Declined because the prompt is too long to review safely.";

	it("never classifies a refusal as overflow, even when its explanation matches an overflow pattern", () => {
		const refusal = createErrorMessage({
			errorMessage: OVERFLOW_LOOKING_REFUSAL,
			refusal: { explanation: "Declined because the prompt is too long to review safely." },
		});
		expect(isContextOverflow(refusal, 100)).toBe(false);
	});

	it("still classifies the same text as overflow without the refusal marker", () => {
		expect(isContextOverflow(createErrorMessage({ errorMessage: OVERFLOW_LOOKING_REFUSAL }), 100)).toBe(true);
	});
});
