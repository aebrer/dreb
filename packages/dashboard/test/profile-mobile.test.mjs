import { describe, expect, it } from "vitest";
import { createSseAggregator, parseArgs, summarizeNumbers } from "../scripts/profile-mobile.mjs";

describe("profile-mobile", () => {
	it("parses a supplied local dashboard URL and profiling options", () => {
		const options = parseArgs([
			"http://127.0.0.1:5343",
			"--duration",
			"2.5",
			"--fleet-samples",
			"3",
			"--burst-gap-ms",
			"100",
		]);

		expect(options).toMatchObject({
			durationMs: 2500,
			fleetSamples: 3,
			burstGapMs: 100,
			base: new URL("http://127.0.0.1:5343"),
		});
	});

	it("rejects missing and invalid CLI arguments", () => {
		expect(() => parseArgs([])).toThrow("dashboard URL is required");
		expect(() => parseArgs(["ftp://127.0.0.1:5343"])).toThrow("must use http or https");
		expect(() => parseArgs(["http://127.0.0.1:5343", "--fleet-samples", "0"])).toThrow("positive integer");
	});

	it("aggregates SSE types and bursts without retaining event payloads", () => {
		const aggregate = createSseAggregator(100);
		const secret = "prompt and tool output must not appear";
		aggregate.ingestText(
			`id: 1\ndata: ${JSON.stringify({ seq: 1, key: "k", event: { type: "agent_start", secret } })}\n\n`,
			0,
		);
		aggregate.ingestText("event: heartbeat\ndata: {}\n\n", 50);
		aggregate.ingestText(
			`id: 2\ndata: ${JSON.stringify({ seq: 2, key: "k", event: { type: "agent_end", secret } })}\n\n`,
			200,
		);
		const summary = aggregate.summary();

		expect(summary.eventsByType).toEqual({
			agent_end: { count: 1, encodedBytes: expect.any(Number) },
			agent_start: { count: 1, encodedBytes: expect.any(Number) },
			heartbeat: { count: 1, encodedBytes: Buffer.byteLength("event: heartbeat\ndata: {}\n\n") },
		});
		expect(summary.bursts).toEqual({
			count: 2,
			eventCount: { count: 2, min: 1, max: 2, mean: 1.5 },
			encodedBytes: expect.objectContaining({ count: 2, min: expect.any(Number), max: expect.any(Number) }),
		});
		expect(JSON.stringify(summary)).not.toContain(secret);
	});

	it("matches complete byte-stream ingestion when an SSE separator is fragmented", () => {
		const encoder = new TextEncoder();
		const secret = "fragmented payload must not appear";
		const agentFrame = `id: 1\r\ndata: ${JSON.stringify({ seq: 1, event: { type: "agent_start", secret } })}\r\n\r\n`;
		const heartbeatFrame = "event: heartbeat\r\ndata: {}\r\n\r\n";
		const agentBytes = encoder.encode(agentFrame);
		const heartbeatBytes = encoder.encode(heartbeatFrame);
		const complete = createSseAggregator(100);
		complete.ingest(agentBytes, 0);
		complete.ingest(heartbeatBytes, 200);

		const fragmented = createSseAggregator(100);
		fragmented.ingest(agentBytes.slice(0, -1), 0);
		fragmented.ingest(agentBytes.slice(-1), 0);
		fragmented.ingest(heartbeatBytes, 200);
		const summary = fragmented.summary();

		expect(summary).toEqual(complete.summary());
		expect(summary).toEqual({
			receivedBytes: agentBytes.byteLength + heartbeatBytes.byteLength,
			unattributedBytes: 0,
			eventsByType: {
				agent_start: { count: 1, encodedBytes: agentBytes.byteLength },
				heartbeat: { count: 1, encodedBytes: heartbeatBytes.byteLength },
			},
			bursts: {
				count: 2,
				eventCount: { count: 2, min: 1, max: 1, mean: 1 },
				encodedBytes: summarizeNumbers([agentBytes.byteLength, heartbeatBytes.byteLength]),
			},
		});
		expect(JSON.stringify(summary)).not.toContain(secret);
	});

	it("matches complete byte-stream ingestion when a multibyte character is fragmented", () => {
		const encoder = new TextEncoder();
		const secret = "sensitive 🧪 payload";
		const frame = `id: 1\ndata: ${JSON.stringify({ seq: 1, event: { type: "agent_message", text: secret } })}\n\n`;
		const bytes = encoder.encode(frame);
		const characterOffset = encoder.encode(frame.slice(0, frame.indexOf("🧪"))).byteLength;
		const splitOffset = characterOffset + 2;
		const complete = createSseAggregator();
		complete.ingest(bytes, 0);

		const fragmented = createSseAggregator();
		fragmented.ingest(bytes.slice(0, splitOffset), 0);
		fragmented.ingest(bytes.slice(splitOffset), 0);
		const summary = fragmented.summary();

		expect(summary).toEqual(complete.summary());
		expect(summary).toEqual({
			receivedBytes: bytes.byteLength,
			unattributedBytes: 0,
			eventsByType: {
				agent_message: { count: 1, encodedBytes: bytes.byteLength },
			},
			bursts: {
				count: 1,
				eventCount: { count: 1, min: 1, max: 1, mean: 1 },
				encodedBytes: { count: 1, min: bytes.byteLength, max: bytes.byteLength, mean: bytes.byteLength },
			},
		});
		expect(JSON.stringify(summary)).not.toContain(secret);
	});

	it("summarizes numeric measurements deterministically", () => {
		expect(summarizeNumbers([4, 8, 12])).toEqual({ count: 3, min: 4, max: 12, mean: 8 });
		expect(summarizeNumbers([])).toEqual({ count: 0, min: 0, max: 0, mean: 0 });
	});
});
