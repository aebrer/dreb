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

	it("summarizes numeric measurements deterministically", () => {
		expect(summarizeNumbers([4, 8, 12])).toEqual({ count: 3, min: 4, max: 12, mean: 8 });
		expect(summarizeNumbers([])).toEqual({ count: 0, min: 0, max: 0, mean: 0 });
	});
});
