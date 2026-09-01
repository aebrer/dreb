/**
 * Regression test for issue 495: a dashboard turn with several multi-MiB
 * images in flight must not kill the RPC child process.
 *
 * Drives the real runRpcMode + real stdout output-guard (no write mocking)
 * against the faux streaming harness, with a fake process.stdout.write that
 * simulates a busy dashboard (permanent pipe backpressure) so every event
 * frame accumulates in the guard's queue. The turn's unique base64 payload
 * far exceeds the guard's 16 MiB cap, and the consumer makes no drain
 * progress until the test flips the backpressure switch — well inside the
 * 30 s no-drain grace window. The session must survive and every frame must
 * be delivered in order.
 *
 * Before the fix, the guard aborted (process.exit(1)) the moment the backlog
 * crossed the cap, so this test would observe the exit and missing frames.
 */

import { createHash } from "node:crypto";
import type { AgentTool } from "@dreb/agent-core";
import type { ImageContent } from "@dreb/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as outputGuard from "../src/core/output-guard.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createHarness, type Harness } from "./test-harness.js";

const MB = 1024 * 1024;

/**
 * A faux 4 MiB image that passes the dashboard's strict PNG signature check
 * (signature, IHDR with nonzero dimensions, IEND) so the child-side dedupe
 * claims it. The filler bytes are arbitrary; only the boundaries matter.
 */
function fauxImage(seed: number): { block: ImageContent; b64: string; bytes: Buffer } {
	const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.from([
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	]); // IHDR 1x1
	const head = Buffer.concat([pngSignature, ihdr]);
	const tail = Buffer.from("IEND");
	const bytes = Buffer.concat([head, Buffer.alloc(4 * MB - head.length - tail.length, seed), tail]);
	const b64 = bytes.toString("base64");
	return { block: { type: "image", data: b64, mimeType: "image/png" }, b64, bytes };
}

/** Mirror of the dashboard server's dashboardImageId. */
function expectedImageId(mimeType: string, bytes: Buffer): string {
	return createHash("sha256").update(mimeType).update(Uint8Array.of(0)).update(bytes).digest("hex");
}

function collectImageReferences(node: unknown, out: string[]): void {
	if (Array.isArray(node)) {
		for (const item of node) collectImageReferences(item, out);
		return;
	}
	if (node && typeof node === "object") {
		const record = node as Record<string, unknown>;
		if (record.type === "image_reference" && typeof record.id === "string") out.push(record.id);
		for (const value of Object.values(record)) collectImageReferences(value, out);
	}
}

describe("runRpcMode multi-image survival (issue 495)", () => {
	const promptImages = [fauxImage(1), fauxImage(2)];
	const toolImages = [fauxImage(3), fauxImage(4), fauxImage(5), fauxImage(6)];
	const allImages = [...promptImages, ...toolImages];

	const fauxImagesTool: AgentTool = {
		name: "faux_images",
		description: "Returns faux tool-result images",
		label: "faux_images",
		parameters: Type.Object({}),
		execute: async () => ({
			content: toolImages.map((img) => img.block),
			details: {},
		}),
	};

	const originalStdoutWrite = process.stdout.write;
	let harness: Harness | undefined;
	let handleInputLine: ((line: string) => void) | undefined;
	const existingStdinEndListeners = new Set(process.stdin.listeners("end"));
	const existingStdinErrorListeners = new Set(process.stdin.listeners("error"));

	afterEach(() => {
		// Disarm the no-drain abort timer and clear the guard queue regardless
		// of how the test ended.
		outputGuard.resetOutputGuardForTests();
		process.stdout.write = originalStdoutWrite;
		vi.restoreAllMocks();
		for (const listener of process.stdin.listeners("end")) {
			if (!existingStdinEndListeners.has(listener))
				process.stdin.off("end", listener as (...args: unknown[]) => void);
		}
		for (const listener of process.stdin.listeners("error")) {
			if (!existingStdinErrorListeners.has(listener)) {
				process.stdin.off("error", listener as (...args: unknown[]) => void);
			}
		}
		handleInputLine = undefined;
		harness?.cleanup();
		harness = undefined;
	});

	it("survives an over-cap backlog while the consumer drains within the grace window", async () => {
		// Permanent backpressure: every frame after the first goes into the
		// guard's queue.
		let writable = false;
		const captured: string[] = [];
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(String(chunk));
			return writable;
		}) as typeof process.stdout.write;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called — the stdout guard aborted the child");
		}) as never);

		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return () => {};
		});

		harness = createHarness({
			responses: [{ toolCalls: [{ name: "faux_images", args: {} }] }, "done"],
			// baseToolsOverride is how a session registers custom tools (it
			// replaces the built-in base tool set).
			baseToolsOverride: { faux_images: fauxImagesTool },
			uiType: "dashboard",
		});
		void runRpcMode(harness.session);
		await vi.waitFor(() => expect(handleInputLine).toBeDefined());

		// One turn with two prompt images plus a tool result carrying four
		// more, each 4 MiB of base64 — ~32 MiB of unique image payload.
		await harness.session.prompt("compare these", { images: promptImages.map((img) => img.block) });

		// The guard queued the whole turn (>>16 MiB, see the post-drain
		// assertion) with a no-drain window armed. The consumer is alive but
		// busy: it must not be killed.
		expect(exitSpy).not.toHaveBeenCalled();

		// The consumer now keeps up: the backlog flushes in order.
		writable = true;
		process.stdout.emit("drain");
		await vi.waitFor(() => expect(captured.length).toBe(harness!.events.length));

		// 0. The queued backlog really did exceed the guard's cap (regression
		// scenario: before the fix this crossed the cap and killed the child).
		expect(captured.reduce((total, line) => total + line.length, 0)).toBeGreaterThan(
			outputGuard.MAX_QUEUED_STDOUT_BYTES,
		);

		// 1. No abort at any point.
		expect(exitSpy).not.toHaveBeenCalled();

		// 2. Every session event became exactly one frame, in order.
		const frames = captured.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(frames.map((frame) => frame.type)).toEqual(harness!.events.map((event) => event.type));

		// 3. Each unique image crossed stdout exactly once (dedupe worked).
		for (const img of allImages) {
			expect(captured.filter((line) => line.includes(img.b64)).length).toBe(1);
		}

		// 4. The final transcript references every image by its stable
		// dashboard-compatible id.
		const refs: string[] = [];
		collectImageReferences(frames[frames.length - 1], refs);
		expect(refs.sort()).toEqual(allImages.map((img) => expectedImageId("image/png", img.bytes)).sort());
	});
});
