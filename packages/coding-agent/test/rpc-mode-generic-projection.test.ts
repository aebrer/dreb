/**
 * Regression tests for issue 535: generic RPC consumers (not --ui dashboard)
 * get bounded message_update frames by default, can opt back into the legacy
 * full frames, and never receive dashboard image references.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as outputGuard from "../src/core/output-guard.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { type RpcModeOptions, runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, type Harness } from "./test-harness.js";

interface Capture {
	lines: string[];
	frames: Array<Record<string, unknown>>;
	detach: () => void;
}

async function start(harness: Harness, options?: RpcModeOptions): Promise<Capture> {
	const lines: string[] = [];
	const frames: Array<Record<string, unknown>> = [];
	let attached = false;
	const existingEnd = new Set(process.stdin.listeners("end"));
	const existingError = new Set(process.stdin.listeners("error"));
	vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
	vi.spyOn(outputGuard, "writeRawStdout").mockImplementation((line) => {
		lines.push(line);
		frames.push(JSON.parse(line) as Record<string, unknown>);
	});
	vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation(() => {
		attached = true;
		return () => {};
	});
	void runRpcMode(harness.session, undefined, options);
	await vi.waitFor(() => expect(attached).toBe(true));
	return {
		lines,
		frames,
		detach: () => {
			for (const l of process.stdin.listeners("end")) {
				if (!existingEnd.has(l)) process.stdin.off("end", l as (...args: unknown[]) => void);
			}
			for (const l of process.stdin.listeners("error")) {
				if (!existingError.has(l)) process.stdin.off("error", l as (...args: unknown[]) => void);
			}
		},
	};
}

async function run(
	size: number,
	uiType: string | undefined,
	options?: RpcModeOptions,
): Promise<{ capture: Capture; harness: Harness }> {
	const harness = createHarness({ responses: ["x".repeat(size)], uiType });
	const capture = await start(harness, options);
	await harness.session.prompt("hi");
	return { capture, harness };
}

function updates(capture: Capture): Array<Record<string, unknown>> {
	return capture.frames.filter((f) => f.type === "message_update");
}

function updateBytes(capture: Capture): number {
	let total = 0;
	for (const line of capture.lines) if (line.includes('"message_update"')) total += line.length;
	return total;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runRpcMode generic event projection (issue 535)", () => {
	for (const uiType of [undefined, "rpc", "agent"]) {
		it(`projects message_update by default for uiType=${String(uiType)}`, async () => {
			const { capture, harness } = await run(4_000, uiType);
			try {
				const frames = updates(capture);
				expect(frames.length).toBeGreaterThan(700);
				for (const frame of frames) {
					expect(frame.message).toBeUndefined();
					expect((frame.assistantMessageEvent as Record<string, unknown>).partial).toBeUndefined();
				}
				const text = frames
					.map((f) => f.assistantMessageEvent as Record<string, unknown>)
					.filter((e) => e.type === "text_delta")
					.map((e) => e.delta as string)
					.join("");
				expect(text).toHaveLength(4_000);
				const end = capture.frames.find(
					(f) => f.type === "message_end" && (f.message as { role?: string }).role === "assistant",
				);
				expect((end?.message as { content: Array<{ text: string }> }).content[0].text).toHaveLength(4_000);
			} finally {
				capture.detach();
				harness.cleanup();
			}
		});
	}

	it("keeps generic message_update bytes near-linear in response length", async () => {
		const small = await run(8_000, "rpc");
		const smallBytes = updateBytes(small.capture);
		small.capture.detach();
		small.harness.cleanup();
		const large = await run(16_000, "rpc");
		const largeBytes = updateBytes(large.capture);
		large.capture.detach();
		large.harness.cleanup();
		expect(largeBytes / smallBytes).toBeLessThan(2.5);
		expect(largeBytes).toBeLessThan(16_000 * 64);
	});

	it("restores legacy full frames with fullMessageUpdates", async () => {
		const { capture, harness } = await run(2_000, "rpc", { fullMessageUpdates: true });
		try {
			const frames = updates(capture);
			expect(frames.length).toBeGreaterThan(300);
			for (const frame of frames) {
				expect(frame.message).toBeDefined();
				expect((frame.assistantMessageEvent as Record<string, unknown>).partial).toBeDefined();
			}
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});

	it("keeps dashboard runtimes projected even when fullMessageUpdates is passed", async () => {
		const { capture, harness } = await run(1_000, "dashboard", { fullMessageUpdates: true });
		try {
			for (const frame of updates(capture)) expect(frame.message).toBeUndefined();
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});

	it("does not exit 0 on stdin end while a fatal stdout exit is pending (review finding 2)", async () => {
		const harness = createHarness({ responses: ["ok"], uiType: "rpc" });
		const capture = await start(harness);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(outputGuard, "isFatalExitPending").mockReturnValue(true);
		try {
			process.stdin.emit("end");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(exitSpy).not.toHaveBeenCalledWith(0);
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});

	it("exits 0 on stdin end when no fatal stdout exit is pending", async () => {
		const harness = createHarness({ responses: ["ok"], uiType: "rpc" });
		const capture = await start(harness);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			process.stdin.emit("end");
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
		} finally {
			capture.detach();
			harness.cleanup();
		}
	});
});
