import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	flushRawStdout,
	isStdoutTakenOver,
	MAX_NO_DRAIN_GRACE_MS,
	MAX_QUEUED_STDOUT_BYTES,
	resetOutputGuardForTests,
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
	resetOutputGuardForTests();
}

/** Spy process.exit so a guard abort cannot kill the test process. */
function spyProcessExit(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as never);
}

describe("output-guard", () => {
	let originalStdoutWrite: typeof process.stdout.write;
	let originalStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		originalStdoutWrite = process.stdout.write;
		originalStderrWrite = process.stderr.write;
		restoreStdout();
		resetOutputGuardForTests();
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

	/** Fake stderr.write that captures chunks and the flush callback (never flushes). */
	function fakeStderrWrite(): { chunks: string[]; callback: () => ((e?: Error | null) => void) | undefined } {
		const chunks: string[] = [];
		let callback: ((e?: Error | null) => void) | undefined;
		process.stderr.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			cb?: (error?: Error | null) => void,
		) => {
			chunks.push(String(chunk));
			callback = typeof encodingOrCallback === "function" ? encodingOrCallback : cb;
			return false;
		}) as typeof process.stderr.write;
		return { chunks, callback: () => callback };
	}

	it("fails loudly for an over-cap backlog that never drains (after the grace window)", () => {
		vi.useFakeTimers();
		try {
			const stderr = fakeStderrWrite();
			const exitSpy = spyProcessExit();

			const writable = false;
			fakeStdoutWrite(() => writable);
			writeRawStdout("trigger"); // accepted, signals backpressure
			writeRawStdout("x".repeat(MAX_QUEUED_STDOUT_BYTES + 1)); // one oversized frame is allowed
			writeRawStdout("next"); // over the cap: the no-drain window starts

			// No immediate kill: a slow-but-alive consumer still has the grace window.
			expect(exitSpy).not.toHaveBeenCalled();
			expect(stderr.chunks).toHaveLength(0);

			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS);
			expect(stderr.chunks.join("")).toContain("stdout write queue exceeded");
			expect(stderr.callback()).toBeTypeOf("function");
			expect(() => stderr.callback()!()).toThrow("process.exit");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not kill a slow consumer that keeps making drain progress under the cap breach", () => {
		vi.useFakeTimers();
		try {
			const stderr = fakeStderrWrite();
			const exitSpy = spyProcessExit();

			let writable = false;
			const chunks = fakeStdoutWrite(() => writable);
			writeRawStdout("trigger"); // accepted, signals backpressure
			writeRawStdout("x".repeat(MAX_QUEUED_STDOUT_BYTES + 1)); // one oversized frame is allowed
			writeRawStdout("next"); // over the cap: window armed

			// The consumer drains progress (accepts the backlog) before the window
			// expires: the session survives and everything flushes in order.
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS - 1_000);
			expect(exitSpy).not.toHaveBeenCalled();
			writable = true;
			process.stdout.emit("drain");
			expect(chunks).toEqual(["trigger", "x".repeat(MAX_QUEUED_STDOUT_BYTES + 1), "next"]);

			// The window disarmed on drain: a full further grace elapses without kill.
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS);
			expect(exitSpy).not.toHaveBeenCalled();
			expect(stderr.chunks).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets the no-drain window on a partial drain that leaves the backlog over the cap", () => {
		vi.useFakeTimers();
		try {
			const stderr = fakeStderrWrite();
			const exitSpy = spyProcessExit();

			// The stream is already full (the first write reports backpressure)
			// and then accepts at most 5 MiB of queued bytes before reporting
			// full again — a slow-but-alive consumer making partial progress.
			let first = true;
			let accepted = 0;
			const DRAIN_BUDGET = 5 * 1024 * 1024;
			fakeStdoutWrite((chunk) => {
				if (first) {
					first = false;
					return false;
				}
				accepted += Buffer.byteLength(chunk);
				return accepted <= DRAIN_BUDGET;
			});

			writeRawStdout("trigger"); // finds the stream full: backpressured
			for (let i = 0; i < 30; i++) {
				writeRawStdout("x".repeat(1024 * 1024)); // 30 MiB queued — over the 16 MiB cap
			}

			// Window armed but not yet expired.
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS / 2);
			expect(exitSpy).not.toHaveBeenCalled();

			// Partial drain: a few 1 MiB chunks leave the queue, then the
			// stream reports full again — the backlog stays over the cap.
			process.stdout.emit("drain");

			// The window was reset by the drain progress: a full further grace
			// elapses with the backlog still over the cap — no kill. (A missing
			// reset would reintroduce the issue 495 death here.)
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS);
			expect(exitSpy).not.toHaveBeenCalled();
			expect(stderr.chunks).toHaveLength(0);

			// A fresh over-cap write re-arms the window, and a consumer that
			// now never drains is still aborted loudly.
			writeRawStdout("x".repeat(1024 * 1024));
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS);
			expect(stderr.chunks.join("")).toContain("stdout write queue exceeded");
			expect(() => stderr.callback()!()).toThrow("process.exit");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps takeover queueing bounded and only exits when the consumer never drains", () => {
		vi.useFakeTimers();
		try {
			const stderr = fakeStderrWrite();
			const exitSpy = spyProcessExit();

			const writable = false;
			fakeStdoutWrite(() => writable);
			takeOverStdout();
			writeRawStdout("trigger"); // accepted, signals backpressure
			writeRawStdout("small"); // queued

			const oversized = "x".repeat(MAX_QUEUED_STDOUT_BYTES);
			writeRawStdout(oversized);
			expect(exitSpy).not.toHaveBeenCalled();
			expect(stderr.chunks).toHaveLength(0);

			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS);
			expect(stderr.chunks.join("")).toContain("stdout write queue exceeded");
			expect(stderr.callback()).toBeTypeOf("function");
			expect(() => stderr.callback()!()).toThrow("process.exit");
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forces a bounded exit when the fatal stderr diagnostic never flushes", () => {
		vi.useFakeTimers();
		try {
			process.stderr.write = (() => false) as typeof process.stderr.write;
			const exitSpy = spyProcessExit();

			fakeStdoutWrite(() => false);
			writeRawStdout("trigger");
			writeRawStdout("small");
			writeRawStdout("x".repeat(MAX_QUEUED_STDOUT_BYTES));

			expect(exitSpy).not.toHaveBeenCalled();
			vi.advanceTimersByTime(MAX_NO_DRAIN_GRACE_MS); // no-drain window expires
			expect(() => vi.advanceTimersByTime(1_000)).toThrow("process.exit"); // forced exit after flush timeout
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
