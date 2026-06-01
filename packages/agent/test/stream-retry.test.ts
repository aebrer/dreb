import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message, type Model } from "@dreb/ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.js";

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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function createConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model: createModel(),
		convertToLlm: (msgs: AgentMessage[]) => msgs as Message[],
		...overrides,
	};
}

function createPrompt(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

/**
 * Create a stream function that simulates stream drops (pushes an error event
 * with a stream-drop error message) N times, then succeeds.
 *
 * This mirrors what actual providers do: detect the missing terminal event,
 * set stopReason to "error", and push an error event to the stream.
 */
function createFailingStreamFn(failCount: number, successMessage: AssistantMessage) {
	let attempts = 0;
	return () => {
		attempts++;
		const stream = new MockAssistantStream();
		if (attempts <= failCount) {
			// Simulate provider detecting a stream drop:
			// 1. Push start with partial content
			// 2. Push error event (like providers do when terminal event is missing)
			setTimeout(() => {
				const errorMsg = createAssistantMessage(
					[{ type: "thinking", thinking: "partial thinking..." }],
					"error",
					"Stream ended without message_delta — connection likely dropped",
				);
				stream.push({ type: "start", partial: errorMsg });
				stream.push({ type: "error", reason: "error", error: errorMsg });
				stream.end();
			}, 0);
		} else {
			// Success
			setTimeout(() => {
				stream.push({ type: "start", partial: successMessage });
				stream.push({ type: "done", reason: "stop", message: successMessage });
				stream.end();
			}, 0);
		}
		return stream;
	};
}

/**
 * Create a stream function that always fails with a non-retryable error.
 */
function createNonRetryableStreamFn() {
	return () => {
		const stream = new MockAssistantStream();
		setTimeout(() => {
			const errorMsg = createAssistantMessage([], "error", "401 Unauthorized — invalid API key");
			stream.push({ type: "error", reason: "error", error: errorMsg });
			stream.end();
		}, 0);
		return stream;
	};
}

async function collectEvents(
	streamFn: () => MockAssistantStream,
	config: AgentLoopConfig,
	signal?: AbortSignal,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const loop = agentLoop(
		[createPrompt("test")],
		{ systemPrompt: "", messages: [], tools: [] },
		config,
		signal,
		streamFn as any,
	);
	for await (const event of loop) {
		events.push(event);
	}
	return events;
}

describe("stream retry on dropped connections", () => {
	it("retries on stream drop and succeeds on second attempt", async () => {
		const successMsg = createAssistantMessage([{ type: "text", text: "Hello!" }]);
		const streamFn = createFailingStreamFn(1, successMsg);
		const events = await collectEvents(
			streamFn,
			createConfig({
				streamRetries: 3,
				streamRetryBaseDelayMs: 10,
			}),
		);

		// Should have a stream_retry event
		const retryEvents = events.filter((e) => e.type === "stream_retry");
		expect(retryEvents).toHaveLength(1);
		expect(retryEvents[0]).toMatchObject({
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 3,
			error: "Stream ended without message_delta — connection likely dropped",
			discardedPartial: {
				content: [{ type: "thinking", thinking: "partial thinking..." }],
			},
		});

		// Should have successfully completed (not errored)
		const endEvents = events.filter((e) => e.type === "agent_end");
		expect(endEvents).toHaveLength(1);

		// The final assistant message should have stopReason "stop", not "error"
		const msgEndEvents = events.filter((e) => e.type === "message_end");
		const lastMsgEnd = msgEndEvents[msgEndEvents.length - 1];
		expect(lastMsgEnd.type).toBe("message_end");
		if (lastMsgEnd.type === "message_end") {
			const msg = lastMsgEnd.message as AssistantMessage;
			expect(msg.stopReason).toBe("stop");
			expect(msg.content).toEqual([{ type: "text", text: "Hello!" }]);
		}
	});

	it("retries multiple times and eventually succeeds", async () => {
		const successMsg = createAssistantMessage([{ type: "text", text: "Finally!" }]);
		const streamFn = createFailingStreamFn(3, successMsg);
		const events = await collectEvents(
			streamFn,
			createConfig({
				streamRetries: 3,
				streamRetryBaseDelayMs: 10,
			}),
		);

		const retryEvents = events.filter((e) => e.type === "stream_retry");
		expect(retryEvents).toHaveLength(3);
		// Verify attempt numbers increment
		expect(retryEvents.map((e) => e.type === "stream_retry" && e.attempt)).toEqual([1, 2, 3]);

		// Final message should succeed
		const msgEndEvents = events.filter((e) => e.type === "message_end");
		const lastMsgEnd = msgEndEvents[msgEndEvents.length - 1];
		if (lastMsgEnd.type === "message_end") {
			expect((lastMsgEnd.message as AssistantMessage).stopReason).toBe("stop");
		}
	});

	it("fails after exhausting all retries", async () => {
		const successMsg = createAssistantMessage([{ type: "text", text: "never reached" }]);
		const streamFn = createFailingStreamFn(4, successMsg);
		const events = await collectEvents(
			streamFn,
			createConfig({
				streamRetries: 3,
				streamRetryBaseDelayMs: 10,
			}),
		);

		// 3 retries, then the 4th failure is not retried
		const retryEvents = events.filter((e) => e.type === "stream_retry");
		expect(retryEvents).toHaveLength(3);

		// Final message should be an error
		const msgEndEvents = events.filter((e) => e.type === "message_end");
		const lastMsgEnd = msgEndEvents[msgEndEvents.length - 1];
		if (lastMsgEnd.type === "message_end") {
			const msg = lastMsgEnd.message as AssistantMessage;
			expect(msg.stopReason).toBe("error");
			expect(msg.errorMessage).toContain("Stream dropped repeatedly");
		}
	});

	it("does NOT retry non-stream-drop errors", async () => {
		const streamFn = createNonRetryableStreamFn();
		const events = await collectEvents(
			streamFn,
			createConfig({
				streamRetries: 3,
				streamRetryBaseDelayMs: 10,
			}),
		);

		// No retry events
		const retryEvents = events.filter((e) => e.type === "stream_retry");
		expect(retryEvents).toHaveLength(0);

		// Error surfaced immediately
		const msgEndEvents = events.filter((e) => e.type === "message_end");
		const lastMsgEnd = msgEndEvents[msgEndEvents.length - 1];
		if (lastMsgEnd.type === "message_end") {
			const msg = lastMsgEnd.message as AssistantMessage;
			expect(msg.stopReason).toBe("error");
			expect(msg.errorMessage).toContain("401 Unauthorized");
		}
	});

	it("respects streamRetries: 0 to disable retries", async () => {
		const successMsg = createAssistantMessage([{ type: "text", text: "never reached" }]);
		const streamFn = createFailingStreamFn(1, successMsg);
		const events = await collectEvents(
			streamFn,
			createConfig({
				streamRetries: 0,
				streamRetryBaseDelayMs: 10,
			}),
		);

		// No retry events
		const retryEvents = events.filter((e) => e.type === "stream_retry");
		expect(retryEvents).toHaveLength(0);

		// Error surfaced immediately
		const msgEndEvents = events.filter((e) => e.type === "message_end");
		const lastMsgEnd = msgEndEvents[msgEndEvents.length - 1];
		if (lastMsgEnd.type === "message_end") {
			expect((lastMsgEnd.message as AssistantMessage).stopReason).toBe("error");
		}
	});

	it("forwards Agent stream retry options into the loop", async () => {
		let attempts = 0;
		const streamFn = () => {
			attempts++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const errorMsg = createAssistantMessage(
					[{ type: "text", text: `partial ${attempts}` }],
					"error",
					"Stream ended without message_delta — connection likely dropped",
				);
				stream.push({ type: "start", partial: errorMsg });
				stream.push({ type: "error", reason: "error", error: errorMsg });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: "", tools: [] },
			streamFn: streamFn as any,
			streamRetries: 1,
			streamRetryBaseDelayMs: 10,
		});
		const events: AgentEvent[] = [];
		agent.subscribe((event) => events.push(event));

		await agent.prompt("test");

		expect(attempts).toBe(2);
		expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(1);
		const messageEnd = events.findLast((e) => e.type === "message_end");
		expect(messageEnd?.type).toBe("message_end");
		if (messageEnd?.type === "message_end") {
			expect((messageEnd.message as AssistantMessage).errorMessage).toContain("Stream dropped repeatedly");
		}
	});

	it("aborts promptly during retry backoff", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const streamFn = (_model: Model<any>, _context: unknown, options?: { signal?: AbortSignal }) => {
			attempts++;
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const errorMsg = createAssistantMessage(
					[{ type: "text", text: "partial before abort" }],
					"error",
					"Stream ended without message_delta — connection likely dropped",
				);
				stream.push({ type: "start", partial: errorMsg });
				stream.push({ type: "error", reason: "error", error: errorMsg });
			});
			return stream;
		};
		setTimeout(() => controller.abort(), 20);

		const events = await Promise.race([
			collectEvents(
				streamFn as any,
				createConfig({
					streamRetries: 3,
					streamRetryBaseDelayMs: 5000,
				}),
				controller.signal,
			),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for abort")), 1000)),
		]);

		expect(attempts).toBe(2);
		expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(1);
		const messageEnd = events.findLast((e) => e.type === "message_end");
		expect(messageEnd?.type).toBe("message_end");
		if (messageEnd?.type === "message_end") {
			expect((messageEnd.message as AssistantMessage).stopReason).toBe("aborted");
		}
	});
});
