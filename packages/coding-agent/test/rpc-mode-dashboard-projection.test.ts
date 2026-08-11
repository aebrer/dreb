/**
 * Regression tests for issue 448: dashboard-mode RPC events must be projected
 * before JSONL serialization so high-rate message_update streams stay bounded
 * on the child->dashboard stdout pipe.
 *
 * Drives runRpcMode against the faux streaming harness with long text
 * responses and inspects the raw serialized frames captured at writeRawStdout.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as outputGuard from "../src/core/output-guard.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, type Harness } from "./test-harness.js";

interface RpcCapture {
	/** Raw JSONL lines exactly as passed to writeRawStdout. */
	lines: string[];
	/** Parsed frames, parallel to lines. */
	frames: Array<Record<string, unknown>>;
	/** Inject a JSONL command line into the RPC server's stdin reader. */
	sendCommand: (command: Record<string, unknown>) => void;
	/** Remove the stdin listeners this runRpcMode invocation registered. */
	detach: () => void;
}

async function startRpcMode(harness: Harness): Promise<RpcCapture> {
	const lines: string[] = [];
	const frames: Array<Record<string, unknown>> = [];
	let handleInputLine: ((line: string) => void) | undefined;
	const existingEndListeners = new Set(process.stdin.listeners("end"));
	const existingErrorListeners = new Set(process.stdin.listeners("error"));

	vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
	vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
		lines.push(line);
		frames.push(JSON.parse(line) as Record<string, unknown>);
	});
	vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
		handleInputLine = onLine;
		return () => {};
	});

	void runRpcMode(harness.session);
	await vi.waitFor(() => expect(handleInputLine).toBeDefined());

	return {
		lines,
		frames,
		sendCommand: (command) => handleInputLine!(JSON.stringify(command)),
		detach: () => {
			for (const listener of process.stdin.listeners("end")) {
				if (!existingEndListeners.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
			}
			for (const listener of process.stdin.listeners("error")) {
				if (!existingErrorListeners.has(listener)) {
					process.stdin.off("error", listener as (...args: unknown[]) => void);
				}
			}
		},
	};
}

function messageUpdateFrames(capture: RpcCapture): Array<Record<string, unknown>> {
	return capture.frames.filter((f) => f.type === "message_update");
}

function serializedMessageUpdateBytes(capture: RpcCapture): number {
	let total = 0;
	for (const line of capture.lines) {
		// Cheap pre-filter on the raw line avoids re-parsing everything.
		if (line.includes('"message_update"')) total += line.length;
	}
	return total;
}

/** Run one streaming turn of the given text size and return the capture. */
async function streamTextOfSize(size: number): Promise<{ capture: RpcCapture; harness: Harness }> {
	const harness = createHarness({ responses: ["x".repeat(size)], uiType: "dashboard" });
	const capture = await startRpcMode(harness);
	await harness.session.prompt("hi");
	return { capture, harness };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runRpcMode dashboard event projection (issue 448)", () => {
	it("projects cumulative fields out of every message_update frame before serialization", async () => {
		const { capture, harness } = await streamTextOfSize(8_000);
		try {
			const updates = messageUpdateFrames(capture);
			// 8,000 chars at 3-5 chars per delta => thousands of updates.
			expect(updates.length).toBeGreaterThan(1_500);

			for (const frame of updates) {
				expect(frame.message).toBeUndefined();
				const streamEvent = frame.assistantMessageEvent as Record<string, unknown>;
				expect(streamEvent.partial).toBeUndefined();
			}

			// Deltas survive and reconstruct the full text.
			const reconstructed = updates
				.map((f) => f.assistantMessageEvent as Record<string, unknown>)
				.filter((e) => e.type === "text_delta")
				.map((e) => e.delta as string)
				.join("");
			expect(reconstructed).toHaveLength(8_000);

			// Every delta frame is small and bounded — no growth with stream position.
			const deltaLines = capture.lines.filter((l) => l.includes('"message_update"') && l.includes('"text_delta"'));
			for (const line of deltaLines) {
				expect(line.length).toBeLessThan(512);
			}

			// The authoritative final message still arrives complete on message_end.
			const messageEnd = capture.frames.find(
				(f) => f.type === "message_end" && (f.message as { role?: string })?.role === "assistant",
			);
			expect(messageEnd).toBeDefined();
			const endMessage = messageEnd?.message as { content?: Array<{ text?: string }> };
			expect(endMessage.content?.[0]?.text).toHaveLength(8_000);
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});

	it("keeps aggregate message_update bytes near-linear in response length", async () => {
		const small = await streamTextOfSize(8_000);
		let smallBytes: number;
		try {
			smallBytes = serializedMessageUpdateBytes(small.capture);
		} finally {
			small.capture.detach();
			small.harness.cleanup();
		}

		const large = await streamTextOfSize(16_000);
		let largeBytes: number;
		try {
			largeBytes = serializedMessageUpdateBytes(large.capture);
		} finally {
			large.capture.detach();
			large.harness.cleanup();
		}

		// Linear growth doubles the bytes when the response doubles; quadratic
		// cumulative serialization would quadruple them (the unprojected shape
		// carries two full copies of the growing message per frame).
		expect(largeBytes / smallBytes).toBeLessThan(2.5);

		// Absolute sanity bound: projected total stays a small multiple of the
		// response size; the unprojected 16 KB response would be ~64 MB.
		expect(largeBytes).toBeLessThan(16_000 * 64);
	});

	it("does not project get_dashboard_snapshot responses", async () => {
		const { capture, harness } = await streamTextOfSize(1_000);
		try {
			const baseline = capture.frames.length;
			capture.sendCommand({ type: "get_dashboard_snapshot" });
			await vi.waitFor(() => {
				expect(
					capture.frames.some(
						(f) => f.type === "response" && f.command === "get_dashboard_snapshot" && f.success === true,
					),
				).toBe(true);
			});

			const response = capture.frames.find(
				(f) => f.type === "response" && f.command === "get_dashboard_snapshot" && f.success === true,
			);
			const data = response?.data as { messages?: Array<{ content?: Array<{ text?: string }> }> };
			const assistant = data.messages?.find((m) => m.content?.[0]?.text && m.content[0].text.length === 1_000);
			expect(assistant).toBeDefined();

			// The barrier event accompanying the snapshot is also present.
			expect(capture.frames.slice(baseline).some((f) => f.type === "dashboard_snapshot_barrier")).toBe(true);
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});

	it("leaves the generic RPC protocol untouched when uiType is not dashboard", async () => {
		const harness = createHarness({ responses: ["x".repeat(4_000)] });
		const capture = await startRpcMode(harness);
		try {
			await harness.session.prompt("hi");

			const updates = messageUpdateFrames(capture);
			expect(updates.length).toBeGreaterThan(700);
			for (const frame of updates) {
				// Generic RPC consumers keep both cumulative fields.
				expect(frame.message).toBeDefined();
				const streamEvent = frame.assistantMessageEvent as Record<string, unknown>;
				expect(streamEvent.partial).toBeDefined();
			}
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});
});
