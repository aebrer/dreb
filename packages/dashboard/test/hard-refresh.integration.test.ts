import { describe, expect, it } from "vitest";
import { applySessionEvent, createSessionViewState, messagesToEntries } from "../src/client/state/reducer.js";
import { DashboardImageService } from "../src/server/dashboard-images.js";
import { EventHub } from "../src/server/event-hub.js";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const block = { type: "image", data: png.toString("base64"), mimeType: "image/png" };

describe("hard-refresh image recovery ordering", () => {
	it("hydrates reference-only snapshots and applies only post-barrier projected events", () => {
		const images = new DashboardImageService({
			generate: async () => ({ bytes: Uint8Array.of(1), mimeType: "image/png", width: 1, height: 1 }),
			close: async () => {},
		});
		const hub = new EventHub();
		hub.setEventProjector((key, event) => images.projectEvent(event, { runtimeKey: key }));
		hub.publish("runtime", { type: "tool_execution_update", toolCallId: "old", partialResult: { content: [block] } });
		const barrierSeq = hub.currentSequence;

		const authoritative = [
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "t1", content: [block] },
		];
		const projectedSnapshot = images.project(authoritative, { runtimeKey: "runtime" }) as any[];
		const later = hub.publish("runtime", {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "final" }, block] },
			isError: false,
		});

		expect(JSON.stringify(projectedSnapshot)).not.toContain(block.data);
		expect(JSON.stringify(later)).not.toContain(block.data);
		expect(later.seq).toBeGreaterThan(barrierSeq);
		const state = createSessionViewState("runtime");
		state.entries = messagesToEntries(projectedSnapshot);
		applySessionEvent(state, later.event);
		expect(state.entries[0]).toMatchObject({
			kind: "tool",
			status: "done",
			resultText: "final",
			images: [{ id: expect.stringMatching(/^[0-9a-f]{64}$/), mimeType: "image/png", size: png.length }],
		});
	});
});
