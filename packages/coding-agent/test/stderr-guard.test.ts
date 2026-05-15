import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isStderrTakenOver,
	restoreStderr,
	takeOverStderr,
	writeIntercepted,
	writeRawStderr,
} from "../src/core/stderr-guard.js";

describe("stderr-guard", () => {
	// Save original so we can restore after each test
	let originalStderrWrite: typeof process.stderr.write;

	beforeEach(() => {
		originalStderrWrite = process.stderr.write;
		// Ensure clean state
		restoreStderr();
	});

	afterEach(() => {
		restoreStderr();
		// Safety: make sure process.stderr.write is the real one
		process.stderr.write = originalStderrWrite;
	});

	it("isStderrTakenOver returns false initially", () => {
		expect(isStderrTakenOver()).toBe(false);
	});

	it("takeOverStderr intercepts writes and routes to callback", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		expect(isStderrTakenOver()).toBe(true);

		process.stderr.write("hello");
		process.stderr.write(" world");

		expect(messages).toEqual(["hello", " world"]);
	});

	it("callback does not fire for empty strings", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		process.stderr.write("");

		expect(messages).toEqual([]);
	});

	it("restoreStderr reverts to original behavior", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		restoreStderr();

		expect(isStderrTakenOver()).toBe(false);

		// After restore, writes should go to original stderr
		// We spy on the original to confirm
		const spy = vi.spyOn({ write: originalStderrWrite }, "write");
		process.stderr.write = spy as unknown as typeof process.stderr.write;
		process.stderr.write("after restore");
		expect(spy).toHaveBeenCalledWith("after restore");
	});

	it("is idempotent — multiple takeOverStderr calls are no-ops", () => {
		const messages1: string[] = [];
		const messages2: string[] = [];

		takeOverStderr((msg) => messages1.push(msg));
		takeOverStderr((msg) => messages2.push(msg)); // Should be ignored

		process.stderr.write("test");

		expect(messages1).toEqual(["test"]);
		expect(messages2).toEqual([]); // Second callback never registered
	});

	it("writeRawStderr bypasses interception", () => {
		const messages: string[] = [];
		const rawWrites: string[] = [];

		// Replace the real stderr.write with a tracker before taking over
		const fakeWrite = ((chunk: string | Uint8Array) => {
			rawWrites.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		process.stderr.write = fakeWrite;

		takeOverStderr((msg) => messages.push(msg));

		// Regular write goes through callback
		process.stderr.write("intercepted");
		expect(messages).toEqual(["intercepted"]);
		expect(rawWrites).toEqual([]); // Did not reach raw

		// writeRawStderr bypasses
		writeRawStderr("bypass");
		expect(rawWrites).toEqual(["bypass"]);
		expect(messages).toEqual(["intercepted"]); // callback not called
	});

	it("calls the callback argument on success", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		let callbackCalled = false;
		// biome-ignore lint/complexity/noBannedTypes: testing overloaded write signature
		(process.stderr.write as Function)("data", () => {
			callbackCalled = true;
		});

		expect(callbackCalled).toBe(true);
		expect(messages).toEqual(["data"]);
	});

	it("handles encoding + callback signature", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		let callbackCalled = false;
		// biome-ignore lint/complexity/noBannedTypes: testing overloaded write signature
		(process.stderr.write as Function)("data", "utf-8", () => {
			callbackCalled = true;
		});

		expect(callbackCalled).toBe(true);
		expect(messages).toEqual(["data"]);
	});

	it("falls back to rawStderrWrite when callback throws", () => {
		const rawWrites: string[] = [];

		// Install a tracker as the raw write target
		const fakeWrite = ((chunk: string | Uint8Array) => {
			rawWrites.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		process.stderr.write = fakeWrite;

		takeOverStderr(() => {
			throw new Error("callback exploded");
		});

		// Write should not throw — it falls back to raw
		process.stderr.write("fallback message");
		expect(rawWrites).toEqual(["fallback message"]);
	});

	it("decodes Uint8Array correctly instead of producing garbage", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
		// biome-ignore lint/complexity/noBannedTypes: testing Uint8Array input
		(process.stderr.write as Function)(bytes);

		expect(messages).toEqual(["hello"]);
	});

	it("decodes Buffer correctly", () => {
		const messages: string[] = [];
		takeOverStderr((msg) => messages.push(msg));

		const buf = Buffer.from("buffer text");
		// biome-ignore lint/complexity/noBannedTypes: testing Buffer input
		(process.stderr.write as Function)(buf);

		expect(messages).toEqual(["buffer text"]);
	});

	describe("writeIntercepted", () => {
		it("passes message and level to callback", () => {
			const calls: Array<{ msg: string; level?: string }> = [];
			takeOverStderr((msg, level) => calls.push({ msg, level }));

			writeIntercepted("a warning", "warn");
			writeIntercepted("an error", "error");
			writeIntercepted("debug info", "debug");

			expect(calls).toEqual([
				{ msg: "a warning", level: "warn" },
				{ msg: "an error", level: "error" },
				{ msg: "debug info", level: "debug" },
			]);
		});

		it("falls back to rawStderrWrite when callback throws", () => {
			const rawWrites: string[] = [];

			const fakeWrite = ((chunk: string | Uint8Array) => {
				rawWrites.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;
			process.stderr.write = fakeWrite;

			takeOverStderr(() => {
				throw new Error("boom");
			});

			writeIntercepted("safe fallback", "error");
			expect(rawWrites).toEqual(["safe fallback"]);
		});

		it("writes to stderr directly when not taken over", () => {
			const writes: string[] = [];
			process.stderr.write = ((chunk: string | Uint8Array) => {
				writes.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;

			writeIntercepted("not intercepted", "warn");
			expect(writes).toEqual(["not intercepted\n"]);
		});
	});
});
