import type { AssistantMessage } from "../types.js";

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the request is too large:
 * either the input exceeds the model's context window, or the request body
 * exceeds a provider or gateway byte cap. A byte cap can reject a request whose
 * token count is far below the context window, so token-based checks cannot
 * anticipate it; recognizing the rejection is what lets compaction recover.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum", or for the
 *   request byte cap "413 {"type":"error","error":{"type":"request_too_large",
 *   "message":"Request exceeds the maximum allowed number of bytes."}}"
 * - Amazon Bedrock: "Input is too long for requested model", or bare "Input is too long."
 * - LiteLLM proxy (any backend): "litellm.ContextWindowExceededError: ..."
 * - HTTP gateways (load balancers, reverse proxies, body-size limits): a 413 status
 *   with its standard reason phrase "Request Entity Too Large", "Payload Too Large",
 *   or "Content Too Large" — possibly inside a multi-line HTML error page
 * - OpenAI: "Your input exceeds the context window of this model"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y", or an HTTP
 *   "413 Request Entity Too Large" when the request body is rejected before tokenization
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Cerebras: Returns "400/413 status code (no body)" - handled separately below
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: May accept overflow silently - handled via full input usage > contextWindow
 * - Ollama: Silently truncates input - not detectable via error message
 *
 * Rate limits are never overflow, even when worded like one. Amazon Bedrock throttles with
 * "Too many tokens, please wait before trying again.", which the generic "too many tokens"
 * fallback would match; THROTTLING_PATTERNS excludes it first.
 */
const LENGTH_RETRY_EXHAUSTED_PATTERN =
	/^Response truncated at (?:the configured output token limit|token limit) after \d+ attempts?(?: — output exceeded the model's maximum token budget)?(?:\nProvider detail: .+)?$/is;

export interface ContextOverflowOptions {
	/** Maximum output tokens requested for the exhausted response. */
	maxOutputTokens?: number;
	/** Estimated request-input tokens when the provider omitted usage. */
	estimatedInputTokens?: number;
}

/** Whether the agent exhausted its bounded retries at the configured output limit. */
export function isOutputLimitExhaustion(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		typeof message.errorMessage === "string" &&
		LENGTH_RETRY_EXHAUSTED_PATTERN.test(message.errorMessage)
	);
}

/**
 * Throttling errors, checked before OVERFLOW_PATTERNS. Waiting clears a throttle and compacting
 * does not, so a match is never overflow and is left to backoff retry instead.
 */
const THROTTLING_PATTERNS = [
	/\bthrottl/i, // AWS ThrottlingException, and Bedrock's in-stream "Throttling error: ..."
	/please wait before trying again/i, // Amazon Bedrock throttle text, kept when a client or proxy drops the exception name
];

const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/request_too_large/i, // Anthropic request byte cap (error type)
	/exceeds the maximum allowed number of bytes/i, // Anthropic request byte cap (message, when a proxy drops the type)
	/input is too long/i, // Amazon Bedrock ("... for requested model", or bare "Input is too long.")
	/ContextWindowExceededError/i, // LiteLLM proxy (exception class for any backend's context or size error)
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/exceeds the limit of \d+/i, // GitHub Copilot
	// HTTP 413 with a standard reason phrase: GitHub Copilot (body rejected before the token
	// check) and generic gateways. The `s` flag lets the phrase sit on a later line, as in
	// nginx's HTML error page. Not a bare 413: Groq's "413 Request too large for model ... on
	// tokens per minute" is a rate limit.
	/\b413\b.*\b(?:request entity|payload|content) too large\b/is,
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Context-constrained truncation: dreb exhausted its length retries and the
 *    provider signal or input-plus-configured-output budget indicates that the
 *    response may not have fit in the remaining context window.
 * 3. Silent overflow: Some providers accept requests beyond the configured window
 *    and return successfully (the server's hard limit may be higher). For these,
 *    we compare input + cacheRead + cacheWrite against the configured window;
 *    output tokens are not part of the input size.
 *
 * Safety refusals and throttling errors (such as Bedrock's "Too many tokens, please wait
 * before trying again.") are never overflow, whatever their text matches.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum", or "request_too_large" (413) for the byte cap
 * - Amazon Bedrock: "Input is too long [for requested model]"
 * - LiteLLM proxy (any backend): "ContextWindowExceededError"
 * - HTTP gateways: 413 with "Request Entity Too Large" / "Payload Too Large" / "Content Too Large"
 * - OpenAI (Completions & Responses): "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter (all backends): "maximum context length is X tokens"
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently, sometimes returns rate limit errors.
 * - GitHub Copilot: May accept input beyond a conservative configured window.
 *   Pass contextWindow to detect these cases using input + cacheRead + cacheWrite.
 * - Ollama: Silently truncates input without error. Cannot be detected via this function.
 *   The response will have usage.input < expected, but we don't know the expected value.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional configured window for usage-based overflow detection
 * @param options - Output limit and input estimate used only after bounded length retries are exhausted
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(
	message: AssistantMessage,
	contextWindow?: number,
	options: ContextOverflowOptions = {},
): boolean {
	// A safety refusal is never an overflow, whatever its provider-supplied explanation says.
	// Treating it as one would compact and re-send the declined context.
	if (message.refusal) {
		return false;
	}

	// Case 1: Check error message patterns
	if (message.stopReason === "error" && message.errorMessage) {
		// A throttle can read like an overflow ("Too many tokens, please wait before trying again.").
		if (THROTTLING_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return false;
		}

		// Check known patterns
		if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}

		// Cerebras returns 400/413 with no body for context overflow
		// Note: 429 is rate limiting (requests/tokens per time), NOT context overflow
		if (/^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message.errorMessage)) {
			return true;
		}

		// A provider can report finish_reason "length" when the response ran out of
		// context rather than output allowance. dreb turns an exhausted retry sequence
		// into this error. Classify it as overflow only when actual usage reaches the
		// context ceiling or the configured output could not fit beside the request.
		if (contextWindow && isOutputLimitExhaustion(message)) {
			const usageTokens =
				message.usage.totalTokens ||
				message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
			if (usageTokens >= contextWindow) {
				return true;
			}

			const recordedInput = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			const inputTokens = recordedInput || options.estimatedInputTokens || 0;
			if (options.maxOutputTokens && inputTokens + options.maxOutputTokens > contextWindow) {
				return true;
			}
		}
	}

	// Case 3: Successful response whose full input usage exceeds the configured window.
	// Anthropic-style usage reports cache creation separately from uncached input.
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	return false;
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
