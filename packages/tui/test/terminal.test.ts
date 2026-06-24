/**
 * Tests for ProcessTerminal input-mode bookkeeping.
 *
 * Regression coverage for the RIS-reset fix (PR 294): recommitAll() re-enables
 * input modes via getInputModeReenableSequence(), which must keep
 * _modifyOtherKeysActive in sync so teardown (stop()/drainInput()) emits the
 * matching disable sequence. A drift here leaks modifyOtherKeys mode to the
 * parent shell on exit.
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

describe("ProcessTerminal input-mode bookkeeping", () => {
	let writes: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		writes = [];
		originalWrite = process.stdout.write;
		// Capture writes without emitting escape sequences into the test runner's terminal.
		(process.stdout as unknown as { write: (data: string) => boolean }).write = (data: string) => {
			writes.push(data);
			return true;
		};
	});

	afterEach(() => {
		(process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
	});

	it("getInputModeReenableSequence() enables modifyOtherKeys and stop() emits the matching disable", () => {
		const terminal = new ProcessTerminal();

		const seq = terminal.getInputModeReenableSequence();
		assert.strictEqual(
			seq,
			"\x1b[?2004h\x1b[>4;2m",
			"non-Kitty branch must re-enable bracketed paste and modifyOtherKeys",
		);

		writes.length = 0;
		terminal.stop();

		assert.ok(
			writes.some((w) => w.includes("\x1b[>4;0m")),
			"stop() must emit the modifyOtherKeys disable after the flag was set",
		);
	});

	it("getInputModeReenableSequence() does not touch modifyOtherKeys when Kitty is active", () => {
		const terminal = new ProcessTerminal();
		// Simulate an active Kitty keyboard protocol session.
		(terminal as unknown as { _kittyProtocolActive: boolean })._kittyProtocolActive = true;

		const seq = terminal.getInputModeReenableSequence();
		assert.strictEqual(
			seq,
			"\x1b[?2004h\x1b[>7u",
			"Kitty branch must re-enable bracketed paste and re-push Kitty flags",
		);

		writes.length = 0;
		terminal.stop();

		assert.ok(
			!writes.some((w) => w.includes("\x1b[>4;0m")),
			"stop() must not emit the modifyOtherKeys disable when it was never enabled",
		);
		assert.ok(
			writes.some((w) => w.includes("\x1b[<u")),
			"stop() must disable the Kitty keyboard protocol",
		);
	});
});
