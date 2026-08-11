import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	flushRawStdout,
	isStdoutTakenOver,
	MAX_QUEUED_STDOUT_BYTES,
	restoreStdout,
	takeOverStdout,
	writeRawStdout,
} from "../src/core/output-guard.js";

/** Install a fake process.stdout.write; returns captured chunks and a backpressure switch. */
function fakeStdoutWrite(impl?: (chunk: string) => boolean) {
	const chunks: string[] = [];
	const fake = ((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) => {
		chunks.push(String(chunk));
		const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (typeof cb === "function") (cb as (error?: Error | null) => void)();
		return impl ? impl(String(chunk)) : true;
	}) as typeof process.stdout.write;
	process.stdout.write = fake;
	return chunks;
}

/** Flush any queued module state left over from a test. */
function flushModuleQueue(): void {
	fakeStdoutWrite();
	process.stdout.emit("drain");
}

describe("output-guard", () => {
	let originalStdoutWrite: typeof process.stdout.write;
	let originalStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		originalStdoutWrite = process.stdout.write;
		originalStderrWrite = process.stderr.write;
		restoreStdout();
	});

	afterEach(() => {
		flushModuleQueue();
		restoreStdout();
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
		vi.restoreAllMocks();
	});

	it("isStdoutTakenOver returns false initially", () => {
		expect(isStdoutTakenOver()).toBe(false);
	});

	it("takeOverStdout routes intercepted stdout writes to stderr", () => {
		const stderrChunks: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;

		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);

		process.stdout.write("intercepted");
		expect(stderrChunks).toEqual(["intercepted"]);
	});

	it("takeOverStdout is idempotent and restoreStdout reverts", () => {
		takeOverStdout();
		takeOverStdout();
		expect(isStdoutTakenOver()).toBe(true);

		restoreStdout();
		expect(isStdoutTakenOver()).toBe(false);

		const chunks = fakeStdoutWrite();
		process.stdout.write("direct");
		expect(chunks).toEqual(["direct"]);
	});

	it("writeRawStdout writes directly when the stream is not backpressured", () => {
		const chunks = fakeStdoutWrite();
		writeRawStdout("one");
		writeRawStdout("two");
		expect(chunks).toEqual(["one", "two"]);
	});

	it("writeRawStdout bypasses stdout interception while taken over", () => {
		const rawStdoutChunks = fakeStdoutWrite();
		const stderrChunks: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;

		takeOverStdout();

		process.stdout.write("intercepted");
		writeRawStdout("protocol");

		expect(stderrChunks).toEqual(["intercepted"]);
		expect(rawStdoutChunks).toEqual(["protocol"]);
	});

	it("queues writes while backpressured and flushes them in order on drain", () => {
		let writable = false;
		const chunks = fakeStdoutWrite(() => writable);

		writeRawStdout("first"); // accepted, returns false -> backpressured
		expect(chunks).toEqual(["first"]);

		writeRawStdout("second");
		writeRawStdout("third");
		// Queued behind the backpressure, not written yet.
		expect(chunks).toEqual(["first"]);

		writable = true;
		process.stdout.emit("drain");
		expect(chunks).toEqual(["first", "second", "third"]);

		// Stream healthy again: writes go direct.
		writeRawStdout("fourth");
		expect(chunks).toEqual(["first", "second", "third", "fourth"]);
	});

	it("queues and drains through the raw stdout writer while taken over", () => {
		let writable = false;
		const rawStdoutChunks = fakeStdoutWrite(() => writable);
		takeOverStdout();

		writeRawStdout("first");
		writeRawStdout("second");
		writeRawStdout("third");
		expect(rawStdoutChunks).toEqual(["first"]);

		writable = true;
		process.stdout.emit("drain");
		expect(rawStdoutChunks).toEqual(["first", "second", "third"]);
	});

	it("does not duplicate the chunk whose write returned false", () => {
		let writable = true;
		const chunks = fakeStdoutWrite(() => writable);

		writeRawStdout("a");
		writable = false;
		writeRawStdout("b"); // accepted by the stream, signals backpressure
		writeRawStdout("c"); // queued
		expect(chunks).toEqual(["a", "b"]);

		writable = true;
		process.stdout.emit("drain");
		expect(chunks).toEqual(["a", "b", "c"]);
	});

	it("stops flushing when the stream fills again and resumes on the next drain", () => {
		let writable = false;
		const chunks = fakeStdoutWrite(() => writable);

		writeRawStdout("one");
		writeRawStdout("two");
		writeRawStdout("three");

		// First drain: the stream accepts one queued chunk then fills again.
		process.stdout.emit("drain");
		expect(chunks).toEqual(["one", "two"]);

		writable = true;
		process.stdout.emit("drain");
		expect(chunks).toEqual(["one", "two", "three"]);
	});

	it("allows one oversized protocol frame to drain without treating it as accumulated backlog", () => {
		let writable = false;
		const chunks = fakeStdoutWrite(() => writable);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		writeRawStdout("trigger"); // accepted, signals backpressure
		const oversized = "x".repeat(MAX_QUEUED_STDOUT_BYTES + 1);
		writeRawStdout(oversized);

		expect(chunks).toEqual(["trigger"]);
		expect(exitSpy).not.toHaveBeenCalled();

		writable = true;
		process.stdout.emit("drain");
		expect(chunks).toEqual(["trigger", oversized]);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("rejects a write queued behind one allowed oversized frame", () => {
		const stderrChunks: string[] = [];
		let stderrCallback: ((error?: Error | null) => void) | undefined;
		process.stderr.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			stderrChunks.push(String(chunk));
			stderrCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			return false;
		}) as typeof process.stderr.write;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		let writable = false;
		fakeStdoutWrite(() => writable);
		writeRawStdout("trigger"); // accepted, signals backpressure
		writeRawStdout("x".repeat(MAX_QUEUED_STDOUT_BYTES + 1)); // one oversized frame is allowed
		writeRawStdout("next"); // accumulated backlog beyond that frame must fail loudly

		expect(exitSpy).not.toHaveBeenCalled();
		expect(stderrChunks.join("")).toContain("stdout write queue exceeded");
		expect(stderrCallback).toBeTypeOf("function");
		expect(() => stderrCallback?.()).toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);

		writable = true;
		process.stdout.emit("drain");
	});

	it("keeps takeover queueing bounded and flushes the fatal diagnostic before exit", () => {
		const stderrChunks: string[] = [];
		let stderrCallback: ((error?: Error | null) => void) | undefined;
		process.stderr.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			stderrChunks.push(String(chunk));
			stderrCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			return false;
		}) as typeof process.stderr.write;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		let writable = false;
		fakeStdoutWrite(() => writable);
		takeOverStdout();
		writeRawStdout("trigger"); // accepted, signals backpressure
		writeRawStdout("small"); // queued

		const oversized = "x".repeat(MAX_QUEUED_STDOUT_BYTES);
		writeRawStdout(oversized);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(stderrChunks.join("")).toContain("stdout write queue exceeded");
		expect(stderrCallback).toBeTypeOf("function");
		expect(() => stderrCallback?.()).toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);

		writable = true;
		process.stdout.emit("drain");
	});

	it("forces a bounded exit when the fatal stderr diagnostic never flushes", () => {
		vi.useFakeTimers();
		try {
			process.stderr.write = (() => false) as typeof process.stderr.write;
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);

			fakeStdoutWrite(() => false);
			writeRawStdout("trigger");
			writeRawStdout("small");
			writeRawStdout("x".repeat(MAX_QUEUED_STDOUT_BYTES));

			expect(exitSpy).not.toHaveBeenCalled();
			expect(() => vi.advanceTimersByTime(1_000)).toThrow("process.exit");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushRawStdout resolves immediately when nothing is queued", async () => {
		fakeStdoutWrite();
		await flushRawStdout();
	});

	it("flushRawStdout waits for queued output to drain", async () => {
		let writable = false;
		const chunks = fakeStdoutWrite(() => writable);

		writeRawStdout("first");
		writeRawStdout("queued");

		let flushed = false;
		const pending = flushRawStdout().then(() => {
			flushed = true;
		});

		// Still backpressured: the flush must not complete.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(flushed).toBe(false);

		writable = true;
		process.stdout.emit("drain");
		await pending;
		expect(flushed).toBe(true);
		expect(chunks.slice(0, 2)).toEqual(["first", "queued"]);
	});
});
