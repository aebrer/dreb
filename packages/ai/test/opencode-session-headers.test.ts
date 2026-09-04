import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isOpenCodeModel,
	OPENCODE_SESSION_HEADER,
	withOpenCodeSessionHeader,
} from "../src/providers/opencode-headers.js";
import { complete, completeSimple } from "../src/stream.js";
import type { Api, Context, Model, ProviderStreamOptions, StreamOptions } from "../src/types.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------------------
// Unit tests: OpenCode endpoint matching
// ---------------------------------------------------------------------------

describe("isOpenCodeModel", () => {
	const pick = (provider: string, baseUrl: string) => ({ provider, baseUrl });

	it("matches the built-in opencode and opencode-go provider ids", () => {
		expect(isOpenCodeModel(pick("opencode", "https://opencode.ai/zen/v1"))).toBe(true);
		expect(isOpenCodeModel(pick("opencode-go", "https://opencode.ai/zen/go/v1"))).toBe(true);
	});

	it("still matches built-in providers when baseUrl points at a configured proxy", () => {
		expect(isOpenCodeModel(pick("opencode", "https://proxy.corp.example/v1"))).toBe(true);
	});

	it("matches custom providers whose base URL hostname is exactly opencode.ai", () => {
		expect(isOpenCodeModel(pick("custom", "https://opencode.ai/zen/v1"))).toBe(true);
		expect(isOpenCodeModel(pick("custom", "https://opencode.ai:8443/v1"))).toBe(true);
		expect(isOpenCodeModel(pick("custom", "HTTPS://OPENCODE.AI/zen/v1"))).toBe(true);
	});

	it("does not match lookalike hostnames", () => {
		expect(isOpenCodeModel(pick("custom", "https://evil-opencode.ai/v1"))).toBe(false);
		expect(isOpenCodeModel(pick("custom", "https://opencode.ai.evil.com/v1"))).toBe(false);
		expect(isOpenCodeModel(pick("custom", "https://notopencode.ai/v1"))).toBe(false);
		expect(isOpenCodeModel(pick("custom", "https://sub.opencode.ai/v1"))).toBe(false);
	});

	it("treats malformed base URLs as non-OpenCode without throwing", () => {
		expect(isOpenCodeModel(pick("custom", "not-a-url"))).toBe(false);
		expect(isOpenCodeModel(pick("custom", ""))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Unit tests: case-insensitive low-precedence header merge
// ---------------------------------------------------------------------------

describe("withOpenCodeSessionHeader", () => {
	const opencodeModel = {
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		headers: undefined,
	};

	it("adds the header for OpenCode models with a session ID without mutating inputs", () => {
		const options: StreamOptions = { apiKey: "k", sessionId: SESSION_ID };
		const result = withOpenCodeSessionHeader(opencodeModel, options);

		expect(result).not.toBe(options);
		expect(result?.headers).toEqual({ [OPENCODE_SESSION_HEADER]: SESSION_ID });
		// The caller's original options stay untouched (concurrent-session isolation)
		expect(options.headers).toBeUndefined();
		// Non-header options are preserved
		expect(result?.apiKey).toBe("k");
	});

	it("returns the same object when no session ID is supplied", () => {
		const options: StreamOptions = { apiKey: "k" };
		expect(withOpenCodeSessionHeader(opencodeModel, options)).toBe(options);
		const empty: StreamOptions = { apiKey: "k", sessionId: "" };
		expect(withOpenCodeSessionHeader(opencodeModel, empty)).toBe(empty);
	});

	it("returns the same object for non-OpenCode models", () => {
		const options: StreamOptions = { apiKey: "k", sessionId: SESSION_ID };
		expect(withOpenCodeSessionHeader({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }, options)).toBe(
			options,
		);
	});

	it("returns the same object when options are missing", () => {
		expect(withOpenCodeSessionHeader(opencodeModel, undefined)).toBeUndefined();
	});

	it("lets an explicit model header win case-insensitively", () => {
		for (const casing of ["x-opencode-session", "X-OpenCode-Session", "X-OPENCODE-SESSION"]) {
			const options: StreamOptions = { sessionId: SESSION_ID };
			const model = {
				provider: "opencode",
				baseUrl: "https://opencode.ai/zen/v1",
				headers: { [casing]: "explicit" },
			};
			expect(withOpenCodeSessionHeader(model, options)).toBe(options);
		}
	});

	it("lets an explicit request header win case-insensitively", () => {
		for (const casing of ["x-opencode-session", "X-OpenCode-Session", "X-OPENCODE-SESSION"]) {
			const options: StreamOptions = { sessionId: SESSION_ID, headers: { [casing]: "explicit" } };
			const result = withOpenCodeSessionHeader(opencodeModel, options);
			expect(result).toBe(options);
			expect(result?.headers).toEqual({ [casing]: "explicit" });
		}
	});

	it("does not mutate an existing request headers object", () => {
		const existing = { "x-custom": "yes" };
		const options: StreamOptions = { sessionId: SESSION_ID, headers: existing };
		const result = withOpenCodeSessionHeader(opencodeModel, options);

		expect(existing).toEqual({ "x-custom": "yes" });
		expect(result?.headers).toEqual({ "x-custom": "yes", [OPENCODE_SESSION_HEADER]: SESSION_ID });
	});
});

// ---------------------------------------------------------------------------
// Protocol tests: final outgoing HTTP headers via the real SDK clients
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
const context: Context = {
	systemPrompt: "You are helpful.",
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

type Capture = { headers: Headers[] };

function installFetchCapture(body: string): Capture {
	const captured: Capture = { headers: [] };
	global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
		captured.headers.push(new Headers(init?.headers));
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	return captured;
}

const chatCompletionsSse = [
	`data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "opencode-model",
		choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
	})}`,
	"",
	`data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "opencode-model",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	})}`,
	"",
	"data: [DONE]",
	"",
	"",
].join("\n");

const responsesSse = [
	`event: response.created`,
	`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
	"",
	`event: response.output_item.added`,
	`data: ${JSON.stringify({
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", content: [] },
	})}`,
	"",
	`event: response.content_part.added`,
	`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
	"",
	`event: response.output_text.delta`,
	`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
	"",
	`event: response.completed`,
	`data: ${JSON.stringify({
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	})}`,
	"",
	"",
].join("\n");

const anthropicSse = [
	"event: message_start",
	`data: ${JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			model: "opencode-model",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	})}`,
	"",
	"event: message_delta",
	`data: ${JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { input_tokens: 1, output_tokens: 1 },
	})}`,
	"",
	"event: message_stop",
	`data: ${JSON.stringify({ type: "message_stop" })}`,
	"",
	"",
].join("\n");

const googleSse = `data: ${JSON.stringify({
	candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
})}

`;

function makeModel<TApi extends Api>(overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	const defaults: Model<"openai-completions"> = {
		id: "opencode-model",
		name: "OpenCode Model",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
	return { ...defaults, ...overrides } as Model<TApi>;
}

function lastHeaders(captured: Capture): Headers {
	expect(captured.headers.length).toBeGreaterThan(0);
	return captured.headers.at(-1)!;
}

describe("OpenCode session header on the wire", () => {
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("sends x-opencode-session on openai-completions", async () => {
		const captured = installFetchCapture(chatCompletionsSse);
		const model = makeModel({});

		const result = await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on openai-responses", async () => {
		const captured = installFetchCapture(responsesSse);
		const model = makeModel<"openai-responses">({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/v1",
		});

		const result = await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on anthropic-messages", async () => {
		const captured = installFetchCapture(anthropicSse);
		const model = makeModel<"anthropic-messages">({
			api: "anthropic-messages",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});

		const result = await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on google-generative-ai", async () => {
		const captured = installFetchCapture(googleSse);
		const model = makeModel<"google-generative-ai">({
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/v1",
		});

		const result = await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends no session header when no session ID is supplied", async () => {
		const captured = installFetchCapture(chatCompletionsSse);

		await complete(makeModel({}), context, { apiKey: "k" });

		expect(lastHeaders(captured).has(OPENCODE_SESSION_HEADER)).toBe(false);
	});

	it("does not send the header for non-OpenCode models even with a session ID", async () => {
		const captured = installFetchCapture(chatCompletionsSse);
		const model = makeModel({
			provider: "some-other-provider",
			baseUrl: "https://api.example.com/v1",
		});

		await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(lastHeaders(captured).has(OPENCODE_SESSION_HEADER)).toBe(false);
	});

	it("lets an explicit mixed-case model header win with exactly one effective value", async () => {
		const captured = installFetchCapture(chatCompletionsSse);
		const model = makeModel({
			headers: { "X-OpenCode-Session": "explicit-value" },
		});

		await complete(model, context, { apiKey: "k", sessionId: SESSION_ID });

		const headers = lastHeaders(captured);
		expect(headers.get(OPENCODE_SESSION_HEADER)).toBe("explicit-value");
		// No differently-cased duplicate of the generated header
		expect(headers.get("X-OPENCODE-SESSION")).toBe("explicit-value"); // Headers lookup is case-insensitive
	});

	it("keeps one stable ID across repeated calls sharing the same options object", async () => {
		const captured = installFetchCapture(chatCompletionsSse);
		const model = makeModel({});
		const shared: ProviderStreamOptions = { apiKey: "k", sessionId: SESSION_ID };

		await complete(model, context, shared);
		await complete(model, context, shared);

		expect(captured.headers).toHaveLength(2);
		for (const headers of captured.headers) {
			expect(headers.get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
		}
		// The shared options object was never rewritten with the generated header
		expect(shared.headers).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Protocol tests via completeSimple — the non-streaming path production agent
// loops import from @dreb/ai. completeSimple strips sessionId from the options
// object and merges the header before delegating to streamSimple, where the
// injection happens — so it must be proven independently of complete().
// ---------------------------------------------------------------------------

describe("OpenCode session header on the wire (completeSimple path)", () => {
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("sends x-opencode-session on openai-completions", async () => {
		const captured = installFetchCapture(chatCompletionsSse);
		const model = makeModel({});

		const result = await completeSimple(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on openai-responses", async () => {
		const captured = installFetchCapture(responsesSse);
		const model = makeModel<"openai-responses">({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/v1",
		});

		const result = await completeSimple(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on anthropic-messages", async () => {
		const captured = installFetchCapture(anthropicSse);
		const model = makeModel<"anthropic-messages">({
			api: "anthropic-messages",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});

		const result = await completeSimple(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});

	it("sends x-opencode-session on google-generative-ai", async () => {
		const captured = installFetchCapture(googleSse);
		const model = makeModel<"google-generative-ai">({
			api: "google-generative-ai",
			baseUrl: "https://opencode.ai/zen/v1",
		});

		const result = await completeSimple(model, context, { apiKey: "k", sessionId: SESSION_ID });

		expect(result.stopReason).toBe("stop");
		expect(lastHeaders(captured).get(OPENCODE_SESSION_HEADER)).toBe(SESSION_ID);
	});
});
