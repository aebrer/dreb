import { describe, expect, it, vi } from "vitest";
import { EventHub, formatSseFrame } from "../src/server/event-hub.js";

function collectClient() {
	const chunks: string[] = [];
	return {
		chunks,
		client: { write: (c: string) => chunks.push(c) },
		envelopes: () =>
			chunks
				.filter((c) => c.includes("data: "))
				.map((c) => JSON.parse(c.split("data: ")[1].split("\n")[0]) as { seq: number; key: string; event: any }),
	};
}

describe("EventHub", () => {
	it("assigns monotonically increasing sequence numbers", () => {
		const hub = new EventHub();
		const a = hub.publish("k1", { type: "agent_start" });
		const b = hub.publish("k1", { type: "agent_end" });
		expect(b.seq).toBe(a.seq + 1);
	});

	it("fans events out to attached clients as SSE frames with ids", () => {
		const hub = new EventHub();
		const { client, chunks, envelopes } = collectClient();
		hub.attach(client);
		hub.publish("k1", { type: "tasks_update" });
		expect(chunks[0]).toMatch(/^id: \d+\ndata: /);
		expect(envelopes()[0].key).toBe("k1");
		expect(envelopes()[0].event.type).toBe("tasks_update");
	});

	it("replays buffered events after Last-Event-ID", () => {
		const hub = new EventHub();
		const e1 = hub.publish("k1", { type: "one" });
		hub.publish("k1", { type: "two" });
		hub.publish("k2", { type: "three" });

		const { client, envelopes } = collectClient();
		hub.attach(client, e1.seq);
		expect(envelopes().map((e) => e.event.type)).toEqual(["two", "three"]);
	});

	it("sends dashboard_resync when the requested id fell out of the buffer", () => {
		const hub = new EventHub(2); // tiny buffer
		hub.publish("k", { type: "one" });
		hub.publish("k", { type: "two" });
		hub.publish("k", { type: "three" }); // evicts "one"

		const { client, envelopes } = collectClient();
		hub.attach(client, 0); // asks for everything from the start — gap exists
		expect(envelopes()[0].event.type).toBe("dashboard_resync");
	});

	it("sends dashboard_resync when reconnecting with a prior id to an empty buffer", () => {
		const hub = new EventHub();
		const { client, envelopes } = collectClient();
		hub.attach(client, 42);
		expect(envelopes()[0].event).toMatchObject({ type: "dashboard_resync", reason: "empty_buffer" });
	});

	it("sends dashboard_resync when Last-Event-ID is ahead of the current buffer", () => {
		const hub = new EventHub();
		hub.publish("k", { type: "one" });
		const { client, envelopes } = collectClient();
		hub.attach(client, 999);
		expect(envelopes()[0].event.type).toBe("dashboard_resync");
	});

	it("detached clients stop receiving", () => {
		const hub = new EventHub();
		const { client, envelopes } = collectClient();
		const detach = hub.attach(client);
		hub.publish("k", { type: "one" });
		detach();
		hub.publish("k", { type: "two" });
		expect(envelopes().map((e) => e.event.type)).toEqual(["one"]);
	});

	it("a throwing client does not break fanout to others", () => {
		const hub = new EventHub();
		const bad = {
			write: vi.fn(() => {
				throw new Error("broken pipe");
			}),
		};
		const { client, envelopes } = collectClient();
		hub.attach(bad);
		hub.attach(client);
		hub.publish("k", { type: "one" });
		expect(envelopes()).toHaveLength(1);
	});

	it("formatSseFrame emits id and single-line JSON data", () => {
		const frame = formatSseFrame({ seq: 7, key: "k", event: { type: "x", text: "a\nb" } });
		expect(frame.startsWith("id: 7\n")).toBe(true);
		// JSON escapes the newline — the frame must contain exactly one data line.
		expect(frame.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
		expect(frame.endsWith("\n\n")).toBe(true);
	});
});
