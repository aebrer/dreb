import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@dreb/ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/index.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("onWarning", () => {
	it("forwards onWarning callback to streamFn options", async () => {
		const onWarning = vi.fn();
		let receivedOnWarning: ((code: string, message: string) => void) | undefined;

		const agent = new Agent({
			onWarning,
			streamFn: (_model, _context, options) => {
				receivedOnWarning = options?.onWarning;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedOnWarning).toBe(onWarning);
	});

	it("onWarning is callable from within streamFn", async () => {
		const onWarning = vi.fn();

		const agent = new Agent({
			onWarning,
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					// Simulate a provider calling onWarning (e.g. on JSON parse failure)
					options?.onWarning?.("json_parse_total_failure", "Both JSON.parse and partial-json failed on: {garbage");
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(onWarning).toHaveBeenCalledOnce();
		expect(onWarning).toHaveBeenCalledWith(
			"json_parse_total_failure",
			"Both JSON.parse and partial-json failed on: {garbage",
		);
	});

	it("works without onWarning (undefined by default)", async () => {
		let receivedOnWarning: ((code: string, message: string) => void) | undefined = () => {};

		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				receivedOnWarning = options?.onWarning;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedOnWarning).toBeUndefined();
	});
});
