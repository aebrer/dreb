import { describe, expect, it, vi } from "vitest";
import { applySessionEvent, createSessionViewState } from "../src/client/state/reducer.js";
import { EventHub, formatHeartbeatFrame, formatSseFrame, projectDashboardEvent } from "../src/server/event-hub.js";

function collectClient() {
	const chunks: string[] = [];
	return {
		chunks,
		client: {
			write: (c: string) => {
				chunks.push(c);
				return undefined;
			},
		},
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
		expect(envelopes()).toHaveLength(1);
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

	it("evicts a client whose write rejects while other clients keep receiving", () => {
		const hub = new EventHub();
		const falseReturning = { write: vi.fn(() => false) };
		const { client, envelopes } = collectClient();
		hub.attach(falseReturning);
		hub.attach(client);
		hub.publish("k", { type: "one" });
		hub.publish("k", { type: "two" });
		expect(falseReturning.write).toHaveBeenCalledTimes(1);
		expect(envelopes().map((event) => event.event.type)).toEqual(["one", "two"]);
		expect(hub.clientCount).toBe(1);
	});

	it("bounds history by encoded bytes as well as entry count", () => {
		const hub = new EventHub({ bufferSize: 10, bufferBytes: 160, replayBytes: 120, eventBytes: 120 });
		hub.publish("k", { type: "one", text: "x".repeat(45) });
		hub.publish("k", { type: "two", text: "x".repeat(45) });
		expect(hub.historyBytes).toBeLessThanOrEqual(160);

		const { client, envelopes } = collectClient();
		hub.attach(client, 0);
		expect(envelopes()).toHaveLength(1);
		expect(envelopes()[0].event).toMatchObject({ type: "dashboard_resync", reason: "buffer_gap" });
	});

	it("replays a viable range in strictly increasing sequence order", () => {
		const hub = new EventHub({ replayBytes: 10_000 });
		const first = hub.publish("k", { type: "one" });
		hub.publish("k", { type: "two" });
		hub.publish("k", { type: "three" });
		const { client, envelopes } = collectClient();
		hub.attach(client, first.seq);
		expect(envelopes().map((event) => event.seq)).toEqual([first.seq + 1, first.seq + 2]);
	});

	it("sends an isolated current-sequence resync without older frames for an over-budget replay", () => {
		const hub = new EventHub({ bufferBytes: 10_000, replayBytes: 150, eventBytes: 500 });
		hub.publish("k", { type: "one", text: "x".repeat(50) });
		hub.publish("k", { type: "two", text: "x".repeat(50) });
		const { client, envelopes } = collectClient();
		hub.attach(client, 0);
		expect(envelopes()).toHaveLength(1);
		expect(envelopes()[0]).toMatchObject({
			seq: 2,
			event: { type: "dashboard_resync", reason: "replay_over_budget" },
		});
		expect(hub.publish("k", { type: "three" }).seq).toBe(3);
	});

	it("keeps healthy clients ordered during sustained targeted recovery", () => {
		const hub = new EventHub({ bufferSize: 8, bufferBytes: 1_200, replayBytes: 1_000, eventBytes: 500 });
		const healthy = collectClient();
		const slow = { write: vi.fn(() => false) };
		hub.attach(healthy.client);
		hub.attach(slow);

		for (let index = 1; index <= 100; index++) {
			hub.publish("k", { type: "tick", index, text: "x".repeat(40) });
		}

		expect(slow.write).toHaveBeenCalledTimes(1);
		expect(hub.clientCount).toBe(1);
		expect(hub.historyCount).toBeLessThanOrEqual(8);
		expect(hub.historyBytes).toBeLessThanOrEqual(1_200);
		expect(healthy.envelopes().map((event) => event.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

		const recovered = collectClient();
		hub.attach(recovered.client, 0);
		expect(recovered.envelopes()).toEqual([
			expect.objectContaining({
				seq: 100,
				event: expect.objectContaining({ type: "dashboard_resync", reason: "buffer_gap" }),
			}),
		]);
		expect(healthy.envelopes()).not.toContainEqual(expect.objectContaining({ event: { type: "dashboard_resync" } }));

		hub.publish("k", { type: "tick", index: 101 });
		expect(healthy.envelopes().at(-1)).toMatchObject({ seq: 101, event: { type: "tick", index: 101 } });
		expect(recovered.envelopes().at(-1)).toMatchObject({ seq: 101, event: { type: "tick", index: 101 } });
	});

	it("stops a rejected replay and never attaches that client for live fanout", () => {
		const hub = new EventHub();
		const first = hub.publish("k", { type: "one" });
		hub.publish("k", { type: "two" });
		const rejected = { write: vi.fn(() => false) };
		hub.attach(rejected, first.seq);
		hub.publish("k", { type: "three" });
		expect(rejected.write).toHaveBeenCalledTimes(1);
		expect(hub.clientCount).toBe(0);
	});

	it("turns an oversized projected event into one explicit resync barrier", () => {
		const hub = new EventHub({ eventBytes: 100 });
		const { client, envelopes } = collectClient();
		hub.attach(client);
		hub.publish("k", { type: "unknown_extension_event", output: "x".repeat(500) });
		expect(envelopes()).toHaveLength(1);
		expect(envelopes()[0]).toMatchObject({
			seq: 1,
			event: { type: "dashboard_resync", reason: "oversized_event" },
		});
		hub.publish("k", { type: "small" });
		expect(envelopes().map((event) => event.event.type)).toEqual(["dashboard_resync", "small"]);
	});

	it("projects only reducer-unused cumulative fields and preserves reducer behavior", () => {
		const events = [
			{ type: "agent_end", messages: [{ huge: "x".repeat(200) }] },
			{
				type: "message_update",
				message: { content: "x".repeat(200) },
				assistantMessageEvent: { type: "text_start" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "tool",
				toolName: "bash",
				args: { huge: "x".repeat(200) },
				partialResult: "ok",
			},
			{ type: "turn_end", message: { huge: "x".repeat(200) }, toolResults: [{ huge: "x".repeat(200) }] },
			{
				type: "stream_retry",
				attempt: 1,
				maxAttempts: 2,
				error: "kept",
				discardedPartial: { huge: "x".repeat(200) },
			},
			{
				type: "length_retry",
				attempt: 1,
				maxAttempts: 2,
				previousMaxTokens: 100,
				nextMaxTokens: 200,
				discardedPartial: { huge: "x".repeat(200) },
			},
			{
				type: "background_agent_event",
				agentId: "child",
				event: { type: "agent_end", messages: [{ huge: "x".repeat(200) }] },
			},
			{ type: "unknown_extension_event", cumulative: "kept" },
		] as Record<string, unknown>[];
		const full = createSessionViewState("k");
		const projected = createSessionViewState("k");
		for (const event of events) {
			applySessionEvent(full, event);
			applySessionEvent(projected, projectDashboardEvent(event));
		}
		expect(projected).toEqual(full);
		expect(projectDashboardEvent(events[0]!)).not.toHaveProperty("messages");
		expect(projectDashboardEvent(events[1]!)).not.toHaveProperty("message");
		expect(projectDashboardEvent(events[2]!)).not.toHaveProperty("args");
		expect(projectDashboardEvent(events[2]!)).toMatchObject({ toolName: "bash" });
		expect(projectDashboardEvent(events[4]!)).not.toHaveProperty("discardedPartial");
		expect(projectDashboardEvent(events[5]!)).not.toHaveProperty("discardedPartial");
		expect(projectDashboardEvent(events[6]!)).toMatchObject({ event: { type: "agent_end" } });
		expect((projectDashboardEvent(events[6]!).event as Record<string, unknown>).messages).toBeUndefined();
		expect(projectDashboardEvent(events[7]!)).toBe(events[7]);
	});

	it("sequences and replays global fleet snapshots without transport special-casing", () => {
		const hub = new EventHub();
		hub.publish("", {
			type: "fleet_snapshot",
			runtimes: [{ key: "runtime-1", cwd: "/tmp/project" }],
		});

		const { client, envelopes } = collectClient();
		hub.attach(client, 0);

		expect(envelopes()).toEqual([
			expect.objectContaining({
				seq: 1,
				key: "",
				event: expect.objectContaining({
					type: "fleet_snapshot",
					runtimes: [expect.objectContaining({ key: "runtime-1" })],
				}),
			}),
		]);
	});

	it("formats observable unnumbered heartbeats outside replay history", () => {
		const frame = formatHeartbeatFrame();
		expect(frame).toBe("event: heartbeat\ndata: {}\n\n");
		expect(frame).not.toContain("id:");
	});

	it("formatSseFrame emits id and single-line JSON data", () => {
		const frame = formatSseFrame({ seq: 7, key: "k", event: { type: "x", text: "a\nb" } });
		expect(frame.startsWith("id: 7\n")).toBe(true);
		// JSON escapes the newline — the frame must contain exactly one data line.
		expect(frame.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
		expect(frame.endsWith("\n\n")).toBe(true);
	});
});
