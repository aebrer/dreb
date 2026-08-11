import { describe, expect, it } from "vitest";
import { projectDashboardRpcEvent } from "../src/modes/rpc/rpc-event-projection.js";

function growingAssistantMessage(textLength: number) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "x".repeat(textLength) }],
		api: "anthropic-messages",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

function makeMessageUpdate(textLength: number) {
	const partial = growingAssistantMessage(textLength);
	return {
		type: "message_update",
		message: { ...partial },
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "xyz",
			partial,
		},
	};
}

describe("projectDashboardRpcEvent", () => {
	it("strips the cumulative top-level message and nested partial from message_update", () => {
		const projected = projectDashboardRpcEvent(makeMessageUpdate(5000));

		expect(projected.type).toBe("message_update");
		expect(projected.message).toBeUndefined();
		const streamEvent = projected.assistantMessageEvent as Record<string, unknown>;
		expect(streamEvent.partial).toBeUndefined();
	});

	it("preserves the delta fields the dashboard reducer reads", () => {
		const projected = projectDashboardRpcEvent(makeMessageUpdate(100));
		const streamEvent = projected.assistantMessageEvent as Record<string, unknown>;

		expect(streamEvent.type).toBe("text_delta");
		expect(streamEvent.contentIndex).toBe(0);
		expect(streamEvent.delta).toBe("xyz");
	});

	it("preserves toolCall and content on their terminal stream events", () => {
		const toolCall = { id: "tc1", name: "bash", arguments: { command: "ls" } };
		const projected = projectDashboardRpcEvent({
			type: "message_update",
			message: growingAssistantMessage(10),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall,
				partial: growingAssistantMessage(10),
			},
		});
		const streamEvent = projected.assistantMessageEvent as Record<string, unknown>;

		expect(streamEvent.toolCall).toEqual(toolCall);
		expect(streamEvent.partial).toBeUndefined();

		const textEnd = projectDashboardRpcEvent({
			type: "message_update",
			message: growingAssistantMessage(10),
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "final text",
				partial: growingAssistantMessage(10),
			},
		});
		expect((textEnd.assistantMessageEvent as Record<string, unknown>).content).toBe("final text");
	});

	it("does not mutate the input event", () => {
		const event = makeMessageUpdate(50);
		projectDashboardRpcEvent(event);

		expect(event.message).toBeDefined();
		expect(event.assistantMessageEvent.partial).toBeDefined();
		expect(event.assistantMessageEvent.partial.content[0].text).toHaveLength(50);
	});

	it("handles a message_update without a nested stream event object", () => {
		const projected = projectDashboardRpcEvent({
			type: "message_update",
			message: growingAssistantMessage(10),
			assistantMessageEvent: null,
		});

		expect(projected.message).toBeUndefined();
		expect(projected.assistantMessageEvent).toBeNull();
	});

	it("recurses into background_agent_event payloads", () => {
		const child = makeMessageUpdate(5000);
		const projected = projectDashboardRpcEvent({
			type: "background_agent_event",
			agentId: "agent-1",
			event: child,
		});

		expect(projected.type).toBe("background_agent_event");
		expect(projected.agentId).toBe("agent-1");
		const projectedChild = projected.event as Record<string, unknown>;
		expect(projectedChild.type).toBe("message_update");
		expect(projectedChild.message).toBeUndefined();
		expect((projectedChild.assistantMessageEvent as Record<string, unknown>).partial).toBeUndefined();
		expect((projectedChild.assistantMessageEvent as Record<string, unknown>).delta).toBe("xyz");

		// The relayed child event must not be mutated — other subscribers share it.
		expect(child.message).toBeDefined();
		expect(child.assistantMessageEvent.partial).toBeDefined();
	});

	it("passes background_agent_event through untouched when the payload is not an object", () => {
		const event = { type: "background_agent_event", agentId: "agent-1", event: "not-an-object" };
		expect(projectDashboardRpcEvent(event)).toBe(event);
	});

	it("returns unknown event types by reference so they stay forward-safe", () => {
		const event = { type: "message_end", message: growingAssistantMessage(10) };
		expect(projectDashboardRpcEvent(event)).toBe(event);

		const extensionEvent = { type: "some_future_extension_event", payload: { a: 1 } };
		expect(projectDashboardRpcEvent(extensionEvent)).toBe(extensionEvent);
	});

	it("keeps projected frames small regardless of cumulative message size", () => {
		for (const size of [100, 1_000, 10_000, 100_000]) {
			const projected = projectDashboardRpcEvent(makeMessageUpdate(size));
			expect(JSON.stringify(projected).length).toBeLessThan(300);
		}
	});
});
