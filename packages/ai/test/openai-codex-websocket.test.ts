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
});
