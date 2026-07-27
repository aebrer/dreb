import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, streamSimple } from "@dreb/ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const originalFetch = global.fetch;
const tempDirs: string[] = [];

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

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

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true });
	}
});

describe("Anthropic registry auth integration", () => {
	test("sends the AuthStorage runtime Bearer credential instead of the materialized fallback", async () => {
		const tempDir = join(tmpdir(), `dreb-test-anthropic-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"custom-bearer": {
						baseUrl: "https://proxy.example.com",
						api: "anthropic-messages",
						apiKey: "load-time-fallback-key",
						authHeader: true,
						models: [
							{
								id: "test-model",
								name: "Test Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("custom-bearer", "runtime-key");
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		const model = registry.find("custom-bearer", "test-model");
		expect(model).toBeDefined();
		if (!model) throw new Error("Expected custom Bearer model");
		expect(model.authMode).toBe("bearer");
		expect(model.headers?.Authorization).toBe("Bearer load-time-fallback-key");

		const apiKey = await registry.getApiKey(model);
		expect(apiKey).toBe("runtime-key");

		let captured: Headers | undefined;
		global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			captured = new Headers(init?.headers);
			return createSseResponse();
		}) as typeof fetch;

		const stream = streamSimple(model, context, { apiKey });
		const errors: string[] = [];
		for await (const event of stream) {
			if (event.type === "error") errors.push(event.error.errorMessage ?? "unknown error");
		}

		expect(errors).toEqual([]);
		expect(captured).toBeDefined();
		expect(captured?.get("authorization")).toBe("Bearer runtime-key");
		expect(captured?.has("x-api-key")).toBe(false);
	});
});
