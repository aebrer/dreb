import assert from "node:assert";
import { describe, it } from "node:test";
import { applyBackgroundErase, visibleWidth } from "../src/utils.js";
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

	it("counts screen rows: one for unmarked/fitting, ceil(width) for ASCII wrapped", () => {
		// Unmarked never wraps — always one row, even if (hypothetically) long.
		assert.equal(screenRowsForLine("x".repeat(50), 20), 1);
		// Marked but fits.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(20)), 20), 1);
		// Marked ASCII over width: ceil(50/20) = 3.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(50)), 20), 3);
		// Exactly 2x width.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(40)), 20), 2);
		// Images are always one entry regardless of marker.
		assert.equal(screenRowsForLine(markWrappable("x".repeat(50)), 20, true), 1);
		// Degenerate width.
		assert.equal(screenRowsForLine(markWrappable("xyz"), 0), 1);
	});

	it("splits a wrapped ASCII line into width-sized rows (markers removed)", () => {
		const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 26 chars
		const line = markWrappable(text);
		const rows = splitToScreenRows(line, 10);
		assert.equal(screenRowsForLine(line, 10), Math.ceil(text.length / 10));
		assert.deepEqual(rows, ["ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ"]);
		assert.equal(rows.length, screenRowsForLine(line, 10));
		for (const r of rows) assert.ok(!r.includes(WRAP_MARKER));
	});

	it("wraps double-width CJK glyphs without splitting at an odd boundary", () => {
		const text = "你好世界你好世界你"; // 9 double-width glyphs, visible width 18.
		const line = markWrappable(text);
		const rows = splitToScreenRows(line, 9);

		assert.equal(screenRowsForLine(line, 9), 3);
		assert.deepEqual(rows, ["你好世界", "你好世界", "你"]);
		assert.equal(rows.length, screenRowsForLine(line, 9));
		assert.equal(rows.join(""), text);
		for (const row of rows) assert.ok(visibleWidth(row) <= 9);
	});

	it("counts one row per double-width glyph when odd width leaves no pair space", () => {
		const text = "你好世";
		const line = markWrappable(text);
		const rows = splitToScreenRows(line, 3);

		assert.equal(screenRowsForLine(line, 3), 3);
		assert.deepEqual(rows, ["你", "好", "世"]);
		assert.equal(rows.length, screenRowsForLine(line, 3));
		assert.equal(rows.join(""), text);
		for (const row of rows) assert.ok(visibleWidth(row) <= 3);
	});

	it("preserves trailing zero-width controls on each split row", () => {
		const text = "abcdefghijklmno";
		const bgFn = (s: string) => `\x1b[41m${s}\x1b[0m`;
		const segmentReset = "\x1b[0m\x1b]8;;\x07";
		const rows = splitToScreenRows(markWrappable(applyBackgroundErase(text, bgFn) + segmentReset), 5);

		assert.equal(rows.length, 3);
		assert.deepEqual(
			rows.map((row) => row.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")),
			["abcde", "fghij", "klmno"],
		);
		for (const row of rows) {
			assert.ok(row.includes("\x1b[K"), "BCE fill must be reattached to every split row");
			assert.ok(row.endsWith(segmentReset), "line reset suffix must be reattached to every split row");
			assert.equal(visibleWidth(row), 5);
		}
	});

	it("returns a single row for unmarked or fitting lines", () => {
		assert.deepEqual(splitToScreenRows("plain text", 40), ["plain text"]);
		assert.deepEqual(splitToScreenRows(markWrappable("fits"), 40), ["fits"]);
		// Unmarked long line is NOT split (the renderer guards it instead).
		assert.deepEqual(splitToScreenRows("x".repeat(50), 20), ["x".repeat(50)]);
	});
});
