import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;
const originalAgentDir = process.env.DREB_CODING_AGENT_DIR;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.DREB_CODING_AGENT_DIR;
	} else {
		process.env.DREB_CODING_AGENT_DIR = originalAgentDir;
	}
	if (originalWebSocket === undefined) {
		delete (globalThis as { WebSocket?: unknown }).WebSocket;
	} else {
		(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
	}
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

type WebSocketListener = (event: unknown) => void;

/**
 * Minimal mock WebSocket that uses addEventListener/removeEventListener.
 * Fires "open" synchronously after construction, and exposes an `emit`
 * helper so tests can push message / error / close events.
 */
class MockWebSocket {
	readyState = 1; // OPEN
	private listeners = new Map<string, Set<WebSocketListener>>();

	constructor(_url: string, _opts?: unknown) {
		// Fire "open" on next microtask so the caller can attach listeners first
		queueMicrotask(() => this.emit("open", {}));
	}

	addEventListener(type: string, listener: WebSocketListener): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}

	removeEventListener(type: string, listener: WebSocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(_data: string): void {
		// no-op for tests
	}

	close(_code?: number, _reason?: string): void {
		this.readyState = 3; // CLOSED
	}

	/** Test helper — dispatch an event to all listeners of the given type */
	emit(type: string, event: unknown): void {
		for (const fn of this.listeners.get(type) ?? []) {
			fn(event);
		}
	}
}

describe("openai-codex WebSocket streaming", () => {
	it("wake() prevents hang when a malformed message precedes valid completion", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();

		let mockSocket: MockWebSocket | undefined;

		// Install mock WebSocket constructor
		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				mockSocket = this;
			}
		};

		// Mock fetch for the system prompt fetches (GitHub release + raw content)
		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const onWarning = vi.fn();
		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket",
			onWarning,
		});

		// Wait for the WebSocket to be created and connected
		await vi.waitFor(() => {
			if (!mockSocket) throw new Error("WebSocket not yet created");
		});

		// Small delay to let send() happen after connection
		await new Promise((r) => setTimeout(r, 50));

		// 1) Send a malformed message — this should NOT hang the consumer
		mockSocket!.emit("message", { data: "{this is not valid json}" });

		// Small delay to let the async handler process
		await new Promise((r) => setTimeout(r, 10));

		// 2) Send valid events: item added, content part, text delta, item done, response.completed
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];

		for (const event of events) {
			mockSocket!.emit("message", { data: JSON.stringify(event) });
			// Small delay between events to mimic real delivery
			await new Promise((r) => setTimeout(r, 5));
		}

		// The stream MUST complete within 2 seconds — if wake() didn't fire on the
		// malformed message, the generator would be stuck waiting forever.
		const result = await Promise.race([
			streamResult.result(),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("Timed out — wake() likely not called after parse failure")), 2000);
			}),
		]);

		expect(result.content.find((c) => c.type === "text")?.text).toBe("Hi");
		expect(result.stopReason).toBe("stop");
		expect(onWarning).toHaveBeenCalledWith("ws_parse_error", expect.stringContaining("Malformed WebSocket message"));
	});

	it("uses delta context (previous_response_id) on follow-up WebSocket requests with the same sessionId", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sessionId = "test-session-delta";

		const sockets: MockWebSocket[] = [];
		const sentMessages: string[] = [];

		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				sockets.push(this);
			}

			send(data: string): void {
				sentMessages.push(data);
			}
		};

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "First message", timestamp: Date.now() }],
		};

		// First request
		const streamResult1 = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sockets.length === 0) throw new Error("WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		// Send first response with a responseId
		const firstEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "First" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "First" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_first_123",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];

		for (const event of firstEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result1 = await streamResult1.result();
		expect(result1.responseId).toBe("resp_first_123");

		// Verify first request did NOT have previous_response_id
		const firstPayload = JSON.parse(sentMessages[0]);
		expect(firstPayload).not.toHaveProperty("previous_response_id");

		// Second request with same sessionId
		const context2: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "First message", timestamp: Date.now() },
				result1,
				{ role: "user", content: "Second message", timestamp: Date.now() },
			],
		};

		const streamResult2 = streamOpenAICodexResponses(model, context2, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		// The cached WebSocket is reused for the same sessionId, so wait for the second message
		await vi.waitFor(() => {
			if (sentMessages.length < 2) throw new Error("Second WebSocket message not yet sent");
		});
		await new Promise((r) => setTimeout(r, 50));

		// Send second response on the reused socket
		const secondEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Second" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_2",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Second" }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];

		for (const event of secondEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result2 = await streamResult2.result();
		expect(result2.content.find((c) => c.type === "text")?.text).toBe("Second");

		// Verify second request uses delta context: it includes previous_response_id
		// and sends only the new input item instead of replaying the whole history.
		const secondPayload = JSON.parse(sentMessages[1]);
		expect(secondPayload.previous_response_id).toBe("resp_first_123");
		expect(secondPayload.input.length).toBeLessThan(firstPayload.input.length + 2);
		expect(secondPayload.input).toHaveLength(1);
	});

	// --- Fallback tests: getCachedWebSocketInputDelta returns undefined ---

	it("sends full body without previous_response_id when request body changes (body mismatch)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sessionId = "test-body-mismatch";

		const sockets: MockWebSocket[] = [];
		const sentMessages: string[] = [];

		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				sockets.push(this);
			}
			send(data: string): void {
				sentMessages.push(data);
			}
		};

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		// --- First request ---
		const context1: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const streamResult1 = streamOpenAICodexResponses(model, context1, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sockets.length === 0) throw new Error("WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		// Complete first request with a responseId
		const firstEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_bm_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_bm_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_bm_first",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of firstEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result1 = await streamResult1.result();
		expect(result1.responseId).toBe("resp_bm_first");

		// --- Second request with DIFFERENT systemPrompt (body mismatch) ---
		const context2: Context = {
			systemPrompt: "You are a pirate.", // Different system prompt → body mismatch
			messages: [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				result1,
				{ role: "user", content: "Follow-up", timestamp: Date.now() },
			],
		};

		const streamResult2 = streamOpenAICodexResponses(model, context2, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sentMessages.length < 2) throw new Error("Second WebSocket message not yet sent");
		});
		await new Promise((r) => setTimeout(r, 50));

		// Complete second request
		const secondEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_bm_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Arrr" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_bm_2",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Arrr" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_bm_second",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of secondEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result2 = await streamResult2.result();
		expect(result2.content.find((c) => c.type === "text")?.text).toBe("Arrr");

		// Assert: second request should NOT use previous_response_id
		// because the body (systemPrompt) changed
		const secondPayload = JSON.parse(sentMessages[1]);
		expect(secondPayload).not.toHaveProperty("previous_response_id");
		// And it should contain the full input array (not a delta)
		expect(secondPayload.input.length).toBeGreaterThan(1);
	});

	it("sends full body without previous_response_id when input prefix no longer matches baseline (prefix mismatch)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sessionId = "test-prefix-mismatch";

		const sockets: MockWebSocket[] = [];
		const sentMessages: string[] = [];

		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				sockets.push(this);
			}
			send(data: string): void {
				sentMessages.push(data);
			}
		};

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		// --- First request ---
		const context1: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Original question", timestamp: Date.now() }],
		};

		const streamResult1 = streamOpenAICodexResponses(model, context1, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sockets.length === 0) throw new Error("WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		const firstEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_pm_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Answer" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_pm_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Answer" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_pm_first",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of firstEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result1 = await streamResult1.result();
		expect(result1.responseId).toBe("resp_pm_first");

		// --- Second request where the user EDITED the earlier message ---
		// The first message changed from "Original question" to "Edited question",
		// so the input no longer starts with the previous baseline → prefix mismatch.
		const context2: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Edited question", timestamp: Date.now() }, // Changed!
				result1,
				{ role: "user", content: "Follow-up", timestamp: Date.now() },
			],
		};

		const streamResult2 = streamOpenAICodexResponses(model, context2, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sentMessages.length < 2) throw new Error("Second WebSocket message not yet sent");
		});
		await new Promise((r) => setTimeout(r, 50));

		const secondEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_pm_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "New answer" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_pm_2",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "New answer" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_pm_second",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of secondEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result2 = await streamResult2.result();
		expect(result2.content.find((c) => c.type === "text")?.text).toBe("New answer");

		// Assert: second request should NOT use previous_response_id
		// because the input prefix (edited message) doesn't match the baseline
		const secondPayload = JSON.parse(sentMessages[1]);
		expect(secondPayload).not.toHaveProperty("previous_response_id");
		// Full input array should be present, not a delta
		expect(secondPayload.input.length).toBeGreaterThan(1);
	});

	it("sends full body without previous_response_id when first response has no responseId (missing lastResponseId)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sessionId = "test-missing-responseid";

		const sockets: MockWebSocket[] = [];
		const sentMessages: string[] = [];

		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				sockets.push(this);
			}
			send(data: string): void {
				sentMessages.push(data);
			}
		};

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		// --- First request: response.completed with NO id ---
		const context1: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const streamResult1 = streamOpenAICodexResponses(model, context1, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sockets.length === 0) throw new Error("WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		// response.completed WITHOUT an id field → output.responseId stays undefined
		const firstEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_mr_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_mr_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.completed",
				response: {
					// No "id" field!
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of firstEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result1 = await streamResult1.result();
		// No responseId was in the completion event
		expect(result1.responseId).toBeUndefined();

		// --- Second request: should send full body since continuation was never set ---
		const context2: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				result1,
				{ role: "user", content: "Follow-up", timestamp: Date.now() },
			],
		};

		const streamResult2 = streamOpenAICodexResponses(model, context2, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sentMessages.length < 2) throw new Error("Second WebSocket message not yet sent");
		});
		await new Promise((r) => setTimeout(r, 50));

		const secondEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_mr_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "World" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_mr_2",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "World" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_mr_second",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of secondEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result2 = await streamResult2.result();
		expect(result2.content.find((c) => c.type === "text")?.text).toBe("World");

		// Assert: second request should NOT use previous_response_id
		// because no continuation was stored (first response had no id)
		const secondPayload = JSON.parse(sentMessages[1]);
		expect(secondPayload).not.toHaveProperty("previous_response_id");
		expect(secondPayload.input.length).toBeGreaterThan(1);
	});

	it("sends full body without previous_response_id after a WebSocket error clears continuation", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "dreb-codex-ws-"));
		process.env.DREB_CODING_AGENT_DIR = tempDir;
		const token = mockToken();
		const sessionId = "test-error-clears-continuation";

		const sockets: MockWebSocket[] = [];
		const sentMessages: string[] = [];

		(globalThis as { WebSocket?: unknown }).WebSocket = class extends MockWebSocket {
			constructor(url: string, opts?: unknown) {
				super(url, opts);
				sockets.push(this);
			}
			send(data: string): void {
				sentMessages.push(data);
			}
		};

		global.fetch = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		// --- First request: succeeds normally ---
		const context1: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const streamResult1 = streamOpenAICodexResponses(model, context1, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sockets.length === 0) throw new Error("WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		const firstEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_ec_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Hi" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_ec_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hi" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_ec_first",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of firstEvents) {
			sockets[0]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result1 = await streamResult1.result();
		expect(result1.responseId).toBe("resp_ec_first");

		// --- Second request: triggers a WebSocket error ---
		const context2: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				result1,
				{ role: "user", content: "Follow-up", timestamp: Date.now() },
			],
		};

		const streamResult2 = streamOpenAICodexResponses(model, context2, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		await vi.waitFor(() => {
			if (sentMessages.length < 2) throw new Error("Second WebSocket message not yet sent");
		});
		await new Promise((r) => setTimeout(r, 50));

		// Emit an error on the socket — this should clear continuation
		sockets[0]!.emit("error", { message: "Connection lost" });

		// The error is caught at the stream level and returned with stopReason "error"
		const result2 = await streamResult2.result();
		expect(result2.stopReason).toBe("error");
		expect(result2.errorMessage).toContain("Connection lost");

		// --- Third request: should send full body without previous_response_id ---
		// (The error cleared the continuation and removed the cached socket)
		const context3: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				result1,
				{ role: "user", content: "New follow-up", timestamp: Date.now() },
			],
		};

		const streamResult3 = streamOpenAICodexResponses(model, context3, {
			apiKey: token,
			transport: "websocket",
			sessionId,
		});

		// A new socket should be created since the old one was closed on error
		await vi.waitFor(() => {
			if (sockets.length < 2) throw new Error("Third WebSocket not yet created");
		});
		await new Promise((r) => setTimeout(r, 50));

		await vi.waitFor(() => {
			if (sentMessages.length < 3) throw new Error("Third WebSocket message not yet sent");
		});

		const thirdEvents = [
			{
				type: "response.output_item.added",
				item: { type: "message", id: "msg_ec_3", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: "Retry" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_ec_3",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Retry" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_ec_third",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 1,
						total_tokens: 6,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		for (const event of thirdEvents) {
			sockets[1]!.emit("message", { data: JSON.stringify(event) });
			await new Promise((r) => setTimeout(r, 5));
		}

		const result3 = await streamResult3.result();
		expect(result3.content.find((c) => c.type === "text")?.text).toBe("Retry");

		// Assert: third request should NOT use previous_response_id
		// because the error cleared the continuation state
		const thirdPayload = JSON.parse(sentMessages[2]);
		expect(thirdPayload).not.toHaveProperty("previous_response_id");
		expect(thirdPayload.input.length).toBeGreaterThan(1);
	});
});
