import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@dreb/ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

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
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("endTurn on tool result", () => {
	it("should stop the loop after tool results when endTurn is true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "bg-launch",
			label: "BG Launch",
			description: "Launches background work",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "Background agent started." }],
					details: {},
					endTurn: true,
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: model makes a tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "bg-launch", arguments: { value: "go" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// This should NOT be reached — endTurn should prevent it
					const message = createAssistantMessage([{ type: "text", text: "I should not appear" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);

		for await (const event of stream) {
			events.push(event);
		}

		// Only one LLM call should have been made
		expect(callIndex).toBe(1);

		// Tool should have executed
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd).toBeDefined();

		// Agent should have ended
		const agentEnd = events.find((e) => e.type === "agent_end");
		expect(agentEnd).toBeDefined();
	});

	it("should execute all tool calls in the same response before stopping", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];

		const bgTool: AgentTool<typeof toolSchema> = {
			name: "bg-launch",
			label: "BG Launch",
			description: "Launches background work",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(`bg:${params.value}`);
				return {
					content: [{ type: "text", text: "Started" }],
					details: {},
					endTurn: true,
				};
			},
		};

		const readTool: AgentTool<typeof toolSchema> = {
			name: "read-file",
			label: "Read",
			description: "Reads a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(`read:${params.value}`);
				return {
					content: [{ type: "text", text: "File contents" }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [bgTool, readTool],
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// Model calls both tools in one response
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "read-file", arguments: { value: "a.txt" } },
							{ type: "toolCall", id: "tool-2", name: "bg-launch", arguments: { value: "go" } },
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "Should not appear" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
		}

		// Both tools should have executed
		expect(executed).toEqual(["read:a.txt", "bg:go"]);
		// But only one LLM call
		expect(callIndex).toBe(1);
	});

	it("should NOT stop the loop when endTurn is false/undefined", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "normal-tool",
			label: "Normal",
			description: "Normal tool",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "done" }],
					details: {},
					// no endTurn
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "normal-tool", arguments: { value: "x" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "final" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			streamFn,
		);
		for await (const _ of stream) {
		}

		// Two LLM calls: tool call + final response
		expect(callIndex).toBe(2);
	});

	it("should reset endTurn flag when follow-up messages restart the outer loop", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "bg-launch",
			label: "BG Launch",
			description: "Launches background work",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "Background agent started." }],
					details: {},
					endTurn: true,
				};
			},
		};

		const normalTool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool, normalTool],
		};

		let callIndex = 0;
		let followUpDelivered = false;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: tool call with endTurn
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "bg-launch", arguments: { value: "go" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else if (callIndex === 1) {
					// Second call (from follow-up): tool call WITHOUT endTurn
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Third call: final text response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getFollowUpMessages: async () => {
				// Deliver one follow-up after endTurn stops the loop
				if (!followUpDelivered) {
					followUpDelivered = true;
					return [createUserMessage("bg agent results here")];
				}
				return [];
			},
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _ of stream) {
		}

		// Three LLM calls: endTurn tool → follow-up triggers new turn → echo tool → final response
		expect(callIndex).toBe(3);
	});
});

describe("shouldContinue", () => {
	it("should stop the loop when shouldContinue returns false", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let continueCount = 0;

		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				// Always return tool calls — the shouldContinue hook should stop us
				const message = createAssistantMessage(
					[{ type: "toolCall", id: `tool-${callIndex}`, name: "echo", arguments: { value: `call-${callIndex}` } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
				callIndex++;
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			shouldContinue: () => {
				continueCount++;
				// Allow first callback (second LLM call), block second (third LLM call)
				return continueCount < 2;
			},
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const _ of stream) {
		}

		// First LLM call is not gated by shouldContinue (it's the initial call).
		// shouldContinue is called before the 2nd call (returns true) and before the 3rd (returns false).
		// So we get 2 LLM calls total.
		expect(callIndex).toBe(2);
		expect(continueCount).toBe(2);
	});

	it("should not emit orphaned turn_start when shouldContinue blocks", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "echoed" }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: `tool-${callIndex}`, name: "echo", arguments: { value: `call-${callIndex}` } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
				callIndex++;
			});
			return stream;
		};

		let shouldContinueCallCount = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			shouldContinue: () => {
				shouldContinueCallCount++;
				// Allow first callback, block second
				return shouldContinueCallCount < 2;
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		// Every turn_start must have a matching turn_end
		const turnStarts = events.filter((e) => e.type === "turn_start").length;
		const turnEnds = events.filter((e) => e.type === "turn_end").length;
		expect(turnStarts).toBe(turnEnds);

		// Should have had 2 turns (first + one more before shouldContinue blocks the third)
		expect(turnEnds).toBe(2);
	});

	it("should preserve pending messages in context when shouldContinue blocks", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "echoed" }],
					details: {},
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		let callIndex = 0;
		let steeringDelivered = false;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: `tool-${callIndex}`, name: "echo", arguments: { value: "x" } }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
				callIndex++;
			});
			return stream;
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			shouldContinue: () => false, // Block immediately on second call
			getSteeringMessages: async () => {
				// Deliver a steering message after the first tool call
				if (!steeringDelivered) {
					steeringDelivered = true;
					return [createUserMessage("user typed this while agent was working")];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		// The steering message should have been emitted as message_start/message_end
		// even though shouldContinue blocked the next LLM call
		const messageEvents = events.filter((e) => e.type === "message_start" && (e as any).message?.role === "user");
		const steeringFound = messageEvents.some(
			(e) => (e as any).message?.content === "user typed this while agent was working",
		);
		expect(steeringFound).toBe(true);

		// Only one LLM call (shouldContinue blocks the second)
		expect(callIndex).toBe(1);
	});
});
