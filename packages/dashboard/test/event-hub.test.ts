import { describe, expect, it, vi } from "vitest";
import { applySessionEvent, createSessionViewState } from "../src/client/state/reducer.js";
import { DashboardImageService } from "../src/server/dashboard-images.js";
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

	it("projects large image bytes before sizing so image size alone never emits an oversized barrier", () => {
		const validPng = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		const bytes = Buffer.concat([validPng, Buffer.alloc(1_100_000, 7)]);
		const images = new DashboardImageService({
			generate: async () => ({ bytes: Uint8Array.of(1), mimeType: "image/png", width: 1, height: 1 }),
			close: async () => {},
		});
		const hub = new EventHub({ eventBytes: 2048 });
		hub.setEventProjector((key, event) => images.projectEvent(event, { runtimeKey: key }));
		const envelope = hub.publish("k", {
			type: "tool_execution_end",
			result: { content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
		});
		expect(envelope.event.type).toBe("tool_execution_end");
		expect(JSON.stringify(envelope)).not.toContain(bytes.toString("base64").slice(0, 100));
		expect(JSON.stringify(envelope)).toContain("image_reference");
	});

	it("removes base64 from every live image-bearing event path, including nested background events", () => {
		const bytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		const image = { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
		const events = [
			{ type: "tool_execution_update", partialResult: { content: [image] } },
			{ type: "tool_execution_end", result: { content: [image] } },
			{ type: "message_start", message: { role: "toolResult", content: [image] } },
			{ type: "message_end", message: { role: "toolResult", content: [image] } },
			{
				type: "background_agent_event",
				agentId: "child",
				event: { type: "tool_execution_end", result: { content: [image] } },
			},
		];
		const images = new DashboardImageService({
			generate: async () => ({ bytes: Uint8Array.of(1), mimeType: "image/png", width: 1, height: 1 }),
			close: async () => {},
		});
		const hub = new EventHub();
		hub.setEventProjector((key, event) => images.projectEvent(event, { runtimeKey: key }));
		for (const event of events) {
			const projected = hub.publish("runtime", event);
			expect(JSON.stringify(projected)).not.toContain(image.data);
			expect(JSON.stringify(projected)).toContain("image_reference");
		}
	});

	it("projects only reducer-unused cumulative fields and preserves reducer behavior", () => {
		const textMessage = (text: string) => ({
			role: "assistant",
			model: "fast-local",
			content: [{ type: "text", text }],
		});
		const thinkingMessage = (thinking: string) => ({
			role: "assistant",
			model: "fast-local",
			content: [{ type: "thinking", thinking }],
		});
		const directDelta = {
			type: "message_update",
			message: textMessage("hello"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				partial: textMessage("hello"),
				futureField: "kept",
			},
			transportField: "kept",
		};
		const directEnd = {
			type: "message_update",
			message: textMessage("hello"),
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "hello",
				partial: textMessage("hello"),
			},
		};
		const childDelta = {
			type: "background_agent_event",
			agentId: "child",
			event: {
				type: "message_update",
				message: thinkingMessage("reasoning"),
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "reasoning",
					partial: thinkingMessage("reasoning"),
				},
			},
		};
		const agentEnd = { type: "agent_end", messages: [{ huge: "x".repeat(200) }] };
		const toolUpdate = {
			type: "tool_execution_update",
			toolCallId: "tool",
			toolName: "bash",
			args: { huge: "x".repeat(200) },
			partialResult: "ok",
		};
		const turnEnd = {
			type: "turn_end",
			message: { huge: "x".repeat(200) },
			toolResults: [{ huge: "x".repeat(200) }],
		};
		const streamRetry = {
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 2,
			error: "kept",
			discardedPartial: { huge: "x".repeat(200) },
		};
		const lengthRetry = {
			type: "length_retry",
			attempt: 1,
			maxAttempts: 2,
			previousMaxTokens: 100,
			nextMaxTokens: 200,
			discardedPartial: { huge: "x".repeat(200) },
		};
		const childEnd = {
			type: "background_agent_event",
			agentId: "child",
			event: { type: "agent_end", messages: [{ huge: "x".repeat(200) }] },
		};
		const unknown = { type: "unknown_extension_event", cumulative: "kept" };
		const events = [
			{ type: "message_start", message: textMessage("") },
			{
				type: "message_update",
				message: textMessage(""),
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: textMessage("") },
			},
			directDelta,
			directEnd,
			{ type: "message_end", message: textMessage("hello") },
			{
				type: "background_agent_event",
				agentId: "child",
				event: { type: "message_start", message: thinkingMessage("") },
			},
			{
				type: "background_agent_event",
				agentId: "child",
				event: {
					type: "message_update",
					message: thinkingMessage(""),
					assistantMessageEvent: {
						type: "thinking_start",
						contentIndex: 0,
						partial: thinkingMessage(""),
					},
				},
			},
			childDelta,
			{
				type: "background_agent_event",
				agentId: "child",
				event: {
					type: "message_update",
					message: thinkingMessage("reasoning"),
					assistantMessageEvent: {
						type: "thinking_end",
						contentIndex: 0,
						content: "reasoning",
						partial: thinkingMessage("reasoning"),
					},
				},
			},
			{
				type: "background_agent_event",
				agentId: "child",
				event: { type: "message_end", message: thinkingMessage("reasoning") },
			},
			agentEnd,
			toolUpdate,
			turnEnd,
			streamRetry,
			lengthRetry,
			childEnd,
			unknown,
		] as Record<string, unknown>[];
		const full = createSessionViewState("k");
		const projected = createSessionViewState("k");
		for (const event of events) {
			applySessionEvent(full, event);
			applySessionEvent(projected, projectDashboardEvent(event));
		}

		expect(projected).toEqual(full);
		expect(projected.entries).toMatchObject([
			{ kind: "assistant", streaming: false, blocks: [{ kind: "text", text: "hello" }] },
		]);
		expect(projected.subagents.child?.entries).toMatchObject([
			{ kind: "assistant", streaming: false, blocks: [{ kind: "thinking", text: "reasoning" }] },
		]);
		const projectedDirect = projectDashboardEvent(directDelta);
		expect(projectedDirect).not.toHaveProperty("message");
		expect(projectedDirect).toMatchObject({
			transportField: "kept",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "hello",
				futureField: "kept",
			},
		});
		expect(projectedDirect.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectDashboardEvent(directEnd)).toMatchObject({
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello" },
		});
		expect(directDelta).toHaveProperty("message");
		expect(directDelta.assistantMessageEvent).toHaveProperty("partial");

		const projectedChild = projectDashboardEvent(childDelta).event as Record<string, unknown>;
		expect(projectedChild).not.toHaveProperty("message");
		expect(projectedChild.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectedChild).toMatchObject({
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning" },
		});
		expect(projectDashboardEvent(agentEnd)).not.toHaveProperty("messages");
		expect(projectDashboardEvent(toolUpdate)).not.toHaveProperty("args");
		expect(projectDashboardEvent(toolUpdate)).toMatchObject({ toolName: "bash" });
		expect(projectDashboardEvent(turnEnd)).not.toHaveProperty("message");
		expect(projectDashboardEvent(turnEnd)).not.toHaveProperty("toolResults");
		expect(projectDashboardEvent(streamRetry)).not.toHaveProperty("discardedPartial");
		expect(projectDashboardEvent(lengthRetry)).not.toHaveProperty("discardedPartial");
		expect(projectDashboardEvent(childEnd)).toMatchObject({ event: { type: "agent_end" } });
		expect((projectDashboardEvent(childEnd).event as Record<string, unknown>).messages).toBeUndefined();
		expect(projectDashboardEvent(unknown)).toBe(unknown);
	});

	it("keeps a long cumulative stream bounded, replayable, and transcript-exact", () => {
		const deltaCount = 2_000;
		const delta = "token ";
		const byteBudget = 512 * 1024;
		const eventBytes = 512;
		const hub = new EventHub({
			bufferSize: deltaCount + 2,
			bufferBytes: byteBudget,
			replayBytes: byteBudget,
			eventBytes,
		});
		const live = collectClient();
		hub.attach(live.client);
		const message = (text: string) => ({
			role: "assistant",
			model: "fast-local",
			content: [{ type: "text", text }],
		});

		hub.publish("runtime", { type: "message_start", message: message("") });
		hub.publish("runtime", {
			type: "message_update",
			message: message(""),
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message("") },
		});
		let expectedText = "";
		let lastRawEvent: Record<string, unknown> | undefined;
		for (let index = 0; index < deltaCount; index += 1) {
			expectedText += delta;
			const partial = message(expectedText);
			lastRawEvent = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
			};
			hub.publish("runtime", lastRawEvent);
		}

		expect(lastRawEvent).toBeDefined();
		expect(
			Buffer.byteLength(formatSseFrame({ seq: deltaCount + 2, key: "runtime", event: lastRawEvent! })),
		).toBeGreaterThan(eventBytes);
		expect(hub.clientCount).toBe(1);
		expect(hub.historyCount).toBe(deltaCount + 2);
		expect(hub.historyBytes).toBeLessThan(byteBudget);
		const liveEnvelopes = live.envelopes();
		expect(liveEnvelopes).toHaveLength(deltaCount + 2);
		expect(liveEnvelopes.some((envelope) => envelope.event.type === "dashboard_resync")).toBe(false);
		const deltaFrameBytes = live.chunks
			.filter((chunk) => chunk.includes('"type":"text_delta"'))
			.map((chunk) => Buffer.byteLength(chunk));
		expect(deltaFrameBytes).toHaveLength(deltaCount);
		expect(Math.max(...deltaFrameBytes)).toBeLessThan(eventBytes);
		expect(Math.max(...deltaFrameBytes) - Math.min(...deltaFrameBytes)).toBeLessThan(16);
		expect(live.chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0)).toBe(hub.historyBytes);

		const replayed = collectClient();
		const replayDiagnostic = vi.fn();
		hub.attach(replayed.client, 0, replayDiagnostic);
		expect(replayDiagnostic).toHaveBeenCalledWith({
			kind: "replay",
			count: deltaCount + 2,
			bytes: hub.historyBytes,
			fromSeq: 1,
			toSeq: deltaCount + 2,
		});
		expect(replayed.envelopes()).toHaveLength(deltaCount + 2);
		expect(replayed.envelopes().some((envelope) => envelope.event.type === "dashboard_resync")).toBe(false);

		const liveState = createSessionViewState("runtime");
		const replayedState = createSessionViewState("runtime");
		for (const envelope of liveEnvelopes) applySessionEvent(liveState, envelope.event);
		for (const envelope of replayed.envelopes()) applySessionEvent(replayedState, envelope.event);
		expect(replayedState).toEqual(liveState);
		expect(liveState.entries).toMatchObject([
			{ kind: "assistant", streaming: true, blocks: [{ kind: "text", text: expectedText }] },
		]);
	});

	it("projects toolcall stream deltas and preserves final toolCall through bounded transport", () => {
		const toolMessage = (args: Record<string, unknown>) => ({
			role: "assistant",
			model: "fast-local",
			content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: args }],
		});
		const toolCall = { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } };
		const start = {
			type: "message_update",
			message: toolMessage({}),
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: toolMessage({}) },
		};
		const delta = {
			type: "message_update",
			message: toolMessage({ cmd: 'ls /tmp"' }),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 2,
				delta: 'ls /tmp"',
				partial: toolMessage({ cmd: 'ls /tmp"' }),
				futureField: "kept",
			},
			transportField: "kept",
		};
		const end = {
			type: "message_update",
			message: toolMessage({ cmd: "ls /tmp" }),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall,
				partial: toolMessage({ cmd: "ls /tmp" }),
			},
		};
		const childEnd = {
			type: "background_agent_event",
			agentId: "child",
			event: {
				type: "message_update",
				message: toolMessage({ cmd: "ls /tmp" }),
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: toolMessage({}) },
			},
		};

		const events = [start, delta, end, childEnd] as Record<string, unknown>[];
		const full = createSessionViewState("k");
		const projected = createSessionViewState("k");
		for (const event of events) {
			applySessionEvent(full, event);
			applySessionEvent(projected, projectDashboardEvent(event));
		}
		expect(projected).toEqual(full);

		const projectedStart = projectDashboardEvent(start);
		expect(projectedStart).not.toHaveProperty("message");
		expect(projectedStart.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectedStart).toMatchObject({ assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });

		const projectedDelta = projectDashboardEvent(delta);
		expect(projectedDelta).not.toHaveProperty("message");
		expect(projectedDelta.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectedDelta).toMatchObject({
			transportField: "kept",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 2,
				delta: 'ls /tmp"',
				futureField: "kept",
			},
		});

		const projectedEnd = projectDashboardEvent(end);
		expect(projectedEnd).not.toHaveProperty("message");
		expect(projectedEnd.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectedEnd.assistantMessageEvent).toMatchObject({
			type: "toolcall_end",
			contentIndex: 2,
			toolCall,
		});

		const projectedChild = projectDashboardEvent(childEnd).event as Record<string, unknown>;
		expect(projectedChild).not.toHaveProperty("message");
		expect(projectedChild.assistantMessageEvent).not.toHaveProperty("partial");
		expect(projectedChild.assistantMessageEvent).toMatchObject({ type: "toolcall_end", toolCall });

		expect(start).toHaveProperty("message");
		expect(start.assistantMessageEvent).toHaveProperty("partial");
		expect(delta).toHaveProperty("message");
		expect(delta.assistantMessageEvent).toHaveProperty("partial");
		expect(end).toHaveProperty("message");
		expect(end.assistantMessageEvent).toHaveProperty("partial");
		expect(childEnd.event).toHaveProperty("message");
		expect((childEnd.event as Record<string, unknown>).assistantMessageEvent).toHaveProperty("partial");

		const deltaCount = 2_000;
		const byteBudget = 512 * 1024;
		const eventBytes = 512;
		const hub = new EventHub({
			bufferSize: deltaCount + 3,
			bufferBytes: byteBudget,
			replayBytes: byteBudget,
			eventBytes,
		});
		const live = collectClient();
		hub.attach(live.client);

		hub.publish("runtime", { type: "message_start", message: toolMessage({}) });
		hub.publish("runtime", {
			type: "message_update",
			message: toolMessage({}),
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: toolMessage({}) },
		});
		let expectedArgs = "";
		let lastRawEvent: Record<string, unknown> | undefined;
		for (let index = 0; index < deltaCount; index += 1) {
			expectedArgs += `arg${index} `;
			const partial = toolMessage({ cmd: expectedArgs });
			lastRawEvent = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: `arg${index} `,
					partial,
				},
			};
			hub.publish("runtime", lastRawEvent);
		}
		hub.publish("runtime", {
			type: "message_update",
			message: toolMessage({ cmd: expectedArgs }),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage({ cmd: expectedArgs }),
			},
		});

		expect(lastRawEvent).toBeDefined();
		expect(
			Buffer.byteLength(formatSseFrame({ seq: deltaCount + 2, key: "runtime", event: lastRawEvent! })),
		).toBeGreaterThan(eventBytes);
		expect(hub.clientCount).toBe(1);
		expect(hub.historyCount).toBe(deltaCount + 3);
		expect(hub.historyBytes).toBeLessThan(byteBudget);
		const liveEnvelopes = live.envelopes();
		expect(liveEnvelopes).toHaveLength(deltaCount + 3);
		expect(liveEnvelopes.some((envelope) => envelope.event.type === "dashboard_resync")).toBe(false);
		expect(liveEnvelopes.at(-1)?.event).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall },
		});
		const deltaFrameBytes = live.chunks
			.filter((chunk) => chunk.includes('"type":"toolcall_delta"'))
			.map((chunk) => Buffer.byteLength(chunk));
		expect(deltaFrameBytes).toHaveLength(deltaCount);
		expect(Math.max(...deltaFrameBytes)).toBeLessThan(eventBytes);
		expect(Math.max(...deltaFrameBytes) - Math.min(...deltaFrameBytes)).toBeLessThan(16);

		const replayed = collectClient();
		const replayDiagnostic = vi.fn();
		hub.attach(replayed.client, 0, replayDiagnostic);
		expect(replayDiagnostic).toHaveBeenCalledWith({
			kind: "replay",
			count: deltaCount + 3,
			bytes: hub.historyBytes,
			fromSeq: 1,
			toSeq: deltaCount + 3,
		});
		expect(replayed.envelopes()).toHaveLength(deltaCount + 3);
		expect(replayed.envelopes().some((envelope) => envelope.event.type === "dashboard_resync")).toBe(false);

		const liveState = createSessionViewState("runtime");
		const replayedState = createSessionViewState("runtime");
		for (const envelope of liveEnvelopes) applySessionEvent(liveState, envelope.event);
		for (const envelope of replayed.envelopes()) applySessionEvent(replayedState, envelope.event);
		expect(replayedState).toEqual(liveState);
	});

	it("preserves assistant stop reason and provider error text on projected message_end", () => {
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "provider returned 500",
				content: [{ type: "text", text: "partial" }],
			},
		};

		expect(projectDashboardEvent(event)).toBe(event);
		const hub = new EventHub();
		const published = hub.publish("k", event);
		expect(published.event).toMatchObject({
			type: "message_end",
			message: {
				stopReason: "error",
				errorMessage: "provider returned 500",
			},
		});
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
