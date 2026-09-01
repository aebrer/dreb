import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDashboardRpcEventProjector, projectDashboardRpcEvent } from "../src/modes/rpc/rpc-event-projection.js";

/** Mirror of the dashboard server's dashboardImageId for cross-checking. */
function expectedImageId(mimeType: string, bytes: Uint8Array): string {
	return createHash("sha256").update(mimeType).update(Uint8Array.of(0)).update(bytes).digest("hex");
}

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

describe("createDashboardRpcEventProjector (issue 495 image dedupe)", () => {
	/** Minimal PNG that passes the dashboard's strict signature check: signature, IHDR (1x1), IEND. */
	function makePng(fill: number[]): Buffer {
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01]),
			Buffer.from(fill),
			Buffer.from("IEND"),
		]);
	}
	const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1, 2, 3, 0xff, 0xd9]);
	const imgA = makePng([1, 2, 3]);
	const b64A = imgA.toString("base64");
	const imgB = makePng([4, 5]);
	const b64B = imgB.toString("base64");
	const b64Jpeg = jpegBytes.toString("base64");
	const imageBlock = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

	it("keeps the first occurrence of a unique image inline", () => {
		const projector = createDashboardRpcEventProjector();
		const event = { type: "message_end", message: { role: "user", content: [imageBlock(b64A)] } };
		const projected = projector(event);
		// No other projection needed: the whole event passes through by reference.
		expect(projected).toBe(event);
	});

	it("replaces later occurrences of the same image with a dashboard-compatible reference", () => {
		const projector = createDashboardRpcEventProjector();
		projector({ type: "message_end", message: { content: [imageBlock(b64A)] } });

		const second = projector({
			type: "tool_execution_end",
			result: { content: [{ type: "text", text: "hi" }, imageBlock(b64A)] },
		}) as { result: { content: Array<Record<string, unknown>> } };

		expect(second.result.content[0]).toEqual({ type: "text", text: "hi" });
		expect(second.result.content[1]).toEqual({
			type: "image_reference",
			id: expectedImageId("image/png", imgA),
			mimeType: "image/png",
			size: imgA.byteLength,
		});
	});

	it("treats the same bytes under a different MIME type as a distinct image", () => {
		const projector = createDashboardRpcEventProjector();
		projector({ type: "message_end", message: { content: [imageBlock(b64Jpeg, "image/jpeg")] } });
		const projected = projector({
			type: "message_end",
			message: { content: [imageBlock(b64Jpeg, "image/png")] },
		}) as { message: { content: Array<Record<string, unknown>> } };
		// Same bytes, different mimeType → different identity (and the JPEG
		// bytes are not a valid PNG) → still inline, no reference.
		expect(projected.message.content[0]).toEqual(imageBlock(b64Jpeg, "image/png"));
	});

	it("keeps non-allowlisted, non-canonical, or signature-mismatched blocks inline (no dedupe identity)", () => {
		const projector = createDashboardRpcEventProjector();
		for (const block of [
			imageBlock(b64A, "image/svg+xml"), // not allowlisted
			{ type: "image", data: b64A.slice(0, b64A.length - 1), mimeType: "image/png" }, // length % 4 != 0
			imageBlock(""), // empty
			{ type: "image", data: "not::base64!!", mimeType: "image/png" }, // invalid alphabet
			imageBlock(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64")), // PNG magic, no IHDR/IEND
			imageBlock(Buffer.from([1, 2, 3, 4, 5]).toString("base64")), // no raster signature at all
			imageBlock(b64Jpeg, "image/png"), // JPEG bytes labeled as PNG
		]) {
			const event = { type: "message_end", message: { content: [block] } };
			expect(projector(event)).toBe(event);
		}
	});

	it("never turns a dashboard-rejected block into a reference (no dangling references)", () => {
		const projector = createDashboardRpcEventProjector();
		const jpegAsPng = jpegBytes.toString("base64");
		const block = imageBlock(jpegAsPng, "image/png");
		// The child's gate mirrors the dashboard's strict decode: a block the
		// dashboard would reject is never content-identified, so every
		// occurrence stays inline (the dashboard drops each, as pre-PR) instead
		// of later occurrences dangling as unresolvable references.
		const first = { type: "message_end", message: { content: [block] } };
		expect(projector(first)).toBe(first);
		const second = projector({
			type: "agent_end",
			messages: [{ role: "user", content: [block] }],
		}) as { messages: Array<{ content: unknown[] }> };
		expect(second.messages[0]!.content).toEqual([block]);
	});

	it("does not mutate input events", () => {
		const projector = createDashboardRpcEventProjector();
		const block = imageBlock(b64B);
		const first = { type: "message_end", message: { content: [block] } };
		projector(first);
		const second = projector({
			type: "agent_end",
			messages: [{ role: "user", content: [block] }],
		}) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
		// Input untouched, output carries the reference.
		expect(block).toEqual(imageBlock(b64B));
		expect(second.messages[0].content[0].type).toBe("image_reference");
	});

	it("returns non-image events by reference so they stay shared with other subscribers", () => {
		const projector = createDashboardRpcEventProjector();
		const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
		expect(projector(event)).toBe(event);
	});

	it("composes with message_update field stripping", () => {
		const projector = createDashboardRpcEventProjector();
		const event = {
			type: "message_update",
			message: { role: "assistant", content: [imageBlock(b64A)] },
			assistantMessageEvent: { type: "text_delta", delta: "x", partial: { big: true } },
		};
		const projected = projector(event) as Record<string, Record<string, unknown>>;
		expect(projected.message).toBeUndefined();
		expect(projected.assistantMessageEvent.partial).toBeUndefined();
		expect(projected.assistantMessageEvent.delta).toBe("x");
	});

	it("tracks each unique image once per projector lifetime across many events", () => {
		const projector = createDashboardRpcEventProjector();
		const seen = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const event = projector({ type: "message_end", message: { content: [imageBlock(b64A)] } }) as {
				message: { content: Array<Record<string, unknown>> };
			};
			seen.add(event.message.content[0].type === "image" ? "inline" : String(event.message.content[0].id));
		}
		expect(seen).toEqual(new Set(["inline", expectedImageId("image/png", imgA)]));
	});
});
