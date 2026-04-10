import assert from "node:assert";
import { describe, it } from "node:test";
import { joinColumns, visibleWidth } from "../src/utils.js";

describe("joinColumns", () => {
	it("merges two equal-height blocks side-by-side", () => {
		const left = ["hello", "world"];
		const right = ["foo", "bar"];
		const result = joinColumns(left, right, 1, 20);

		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0], "hello foo");
		assert.strictEqual(result[1], "world bar");
	});

	it("pads right rows when left is taller", () => {
		const left = ["aaa", "bbb", "ccc"];
		const right = ["x", "y"];
		const result = joinColumns(left, right, 2, 20);

		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0], "aaa  x");
		assert.strictEqual(result[1], "bbb  y");
		assert.strictEqual(result[2], "ccc  ");
	});

	it("pads left rows when right is taller", () => {
		const left = ["aa"];
		const right = ["xx", "yy", "zz"];
		const result = joinColumns(left, right, 2, 20);

		assert.strictEqual(result.length, 3);
		assert.strictEqual(result[0], "aa  xx");
		assert.strictEqual(result[1], "    yy");
		assert.strictEqual(result[2], "    zz");
	});

	it("truncates right side when total exceeds totalWidth", () => {
		const left = ["hello"];
		const right = ["abcdefghijklmnopqrstuvwxyz"];
		const result = joinColumns(left, right, 2, 13);

		assert.strictEqual(result.length, 1);
		const line = result[0]!;
		// left "hello" = 5, gap = 2, right truncated to 13-5-2 = 6 chars
		assert.strictEqual(visibleWidth(line), 13);
		assert.ok(line.startsWith("hello  "));
	});

	it("handles ANSI codes without breaking width calculation", () => {
		const left = ["\x1b[31mhi\x1b[0m", "\x1b[32mbye\x1b[0m"];
		const right = ["\x1b[34mfoo\x1b[0m", "\x1b[35mbar\x1b[0m"];
		const result = joinColumns(left, right, 1, 20);

		assert.strictEqual(result.length, 2);
		// left col width = max(2, 3) = 3, so "hi" gets 1 padding space
		// left col width = max(2, 3) = 3; "hi" (width 2) padded by 1 space, then gap=1
		assert.strictEqual(result[0]!, "\x1b[31mhi\x1b[0m  \x1b[34mfoo\x1b[0m");
		assert.strictEqual(result[1]!, "\x1b[32mbye\x1b[0m \x1b[35mbar\x1b[0m");
	});

	it("returns empty array when both blocks are empty", () => {
		const result = joinColumns([], [], 1, 20);
		assert.strictEqual(result.length, 0);
	});

	it("handles empty left block", () => {
		const right = ["abc", "def"];
		const result = joinColumns([], right, 2, 20);

		assert.strictEqual(result.length, 2);
		// left col width = 0, gap = 2, so lines start with 2 spaces then right content
		assert.strictEqual(result[0], "  abc");
		assert.strictEqual(result[1], "  def");
	});

	it("handles empty right block", () => {
		const left = ["abc", "def"];
		const result = joinColumns(left, [], 2, 20);

		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0], "abc  ");
		assert.strictEqual(result[1], "def  ");
	});

	it("works with gap of 0", () => {
		const left = ["ab", "cd"];
		const right = ["xy", "zw"];
		const result = joinColumns(left, right, 0, 20);

		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0], "abxy");
		assert.strictEqual(result[1], "cdzw");
	});

	it("pads left column to max visible width across all left lines", () => {
		const left = ["a", "bbb", "cc"];
		const right = ["x", "y", "z"];
		const result = joinColumns(left, right, 1, 20);

		assert.strictEqual(result.length, 3);
		// left col width = 3 (from "bbb"), so "a" gets 2 padding, "cc" gets 1 padding
		assert.strictEqual(result[0], "a   x");
		assert.strictEqual(result[1], "bbb y");
		assert.strictEqual(result[2], "cc  z");
	});
});
