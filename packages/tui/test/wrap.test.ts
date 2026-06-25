import assert from "node:assert";
import { describe, it } from "node:test";
import {
	isWrappableLine,
	markWrappable,
	screenRowsForLine,
	splitToScreenRows,
	stripWrapMarker,
	WRAP_MARKER,
} from "../src/wrap.js";

describe("wrap helpers", () => {
	it("marks and detects wrappable lines", () => {
		assert.equal(isWrappableLine("plain"), false);
		const marked = markWrappable("hello");
		assert.equal(isWrappableLine(marked), true);
		// Idempotent.
		assert.equal(markWrappable(marked), marked);
	});

	it("strips the marker for emission and leaves visible text intact", () => {
		const marked = markWrappable("hello world");
		assert.equal(stripWrapMarker(marked), "hello world");
		assert.ok(marked.includes(WRAP_MARKER));
		assert.ok(!stripWrapMarker(marked).includes(WRAP_MARKER));
		// No-op on unmarked lines.
		assert.equal(stripWrapMarker("plain"), "plain");
	});

	it("counts screen rows: one for unmarked/fitting, ceil(width) for wrapped", () => {
		// Unmarked never wraps — always one row, even if (hypothetically) long.
		assert.equal(screenRowsForLine("x".repeat(50), 20), 1);
		// Marked but fits.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(20)), 20), 1);
		// Marked and over width: ceil(50/20) = 3.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(50)), 20), 3);
		// Exactly 2x width.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(40)), 20), 2);
		// Images are always one entry regardless of marker.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(50)), 20, true), 1);
		// Degenerate width.
		assert.equal(screenRowsForLine(markWrappable("xyz"), 0), 1);
	});

	it("splits a wrapped line into width-sized rows (markers removed)", () => {
		const line = markWrappable("ABCDEFGHIJKLMNOPQRSTUVWXYZ"); // 26 chars
		const rows = splitToScreenRows(line, 10);
		assert.deepEqual(rows, ["ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ"]);
		for (const r of rows) assert.ok(!r.includes(WRAP_MARKER));
	});

	it("returns a single row for unmarked or fitting lines", () => {
		assert.deepEqual(splitToScreenRows("plain text", 40), ["plain text"]);
		assert.deepEqual(splitToScreenRows(markWrappable("fits"), 40), ["fits"]);
		// Unmarked long line is NOT split (the renderer guards it instead).
		assert.deepEqual(splitToScreenRows("x".repeat(50), 20), ["x".repeat(50)]);
	});
});
