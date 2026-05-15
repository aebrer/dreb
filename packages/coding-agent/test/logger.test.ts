import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { log } from "../src/core/logger.js";
import { restoreStderr, takeOverStderr } from "../src/core/stderr-guard.js";

describe("logger", () => {
	let originalStderrWrite: typeof process.stderr.write;
	let interceptedMessages: Array<{ msg: string; level?: string }> = [];

	beforeEach(() => {
		originalStderrWrite = process.stderr.write;
		interceptedMessages = [];
		restoreStderr();
		delete process.env.DREB_DEBUG;
	});

	afterEach(() => {
		restoreStderr();
		process.stderr.write = originalStderrWrite;
		delete process.env.DREB_DEBUG;
	});

	describe("when stderr is NOT taken over (non-interactive mode)", () => {
		it("log.debug writes to stderr", () => {
			const writes: string[] = [];
			process.stderr.write = ((chunk: string | Uint8Array) => {
				writes.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;

			log.debug("debug msg");
			expect(writes).toContain("debug msg\n");
		});

		it("log.warn writes to stderr", () => {
			const writes: string[] = [];
			process.stderr.write = ((chunk: string | Uint8Array) => {
				writes.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;

			log.warn("warn msg");
			expect(writes).toContain("warn msg\n");
		});

		it("log.error writes to stderr", () => {
			const writes: string[] = [];
			process.stderr.write = ((chunk: string | Uint8Array) => {
				writes.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;

			log.error("error msg");
			expect(writes).toContain("error msg\n");
		});
	});

	describe("when stderr IS taken over (interactive TUI mode)", () => {
		beforeEach(() => {
			takeOverStderr((msg, level) => interceptedMessages.push({ msg, level }));
		});

		it("log.debug is suppressed (no callback fire)", () => {
			log.debug("debug noise");
			expect(interceptedMessages).toEqual([]);
		});

		it("log.debug fires callback with level 'debug' when DREB_DEBUG=1", () => {
			restoreStderr();
			process.env.DREB_DEBUG = "1";
			takeOverStderr((msg, level) => interceptedMessages.push({ msg, level }));

			log.debug("debug visible");
			expect(interceptedMessages).toEqual([{ msg: "debug visible", level: "debug" }]);
		});

		it("log.warn fires callback with level 'warn'", () => {
			log.warn("warning message");
			expect(interceptedMessages).toEqual([{ msg: "warning message", level: "warn" }]);
		});

		it("log.error fires callback with level 'error'", () => {
			log.error("error message");
			expect(interceptedMessages).toEqual([{ msg: "error message", level: "error" }]);
		});

		it("log.warn and log.error use different levels", () => {
			log.warn("w");
			log.error("e");
			expect(interceptedMessages).toEqual([
				{ msg: "w", level: "warn" },
				{ msg: "e", level: "error" },
			]);
		});
	});
});
