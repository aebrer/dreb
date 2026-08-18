import { describe, expect, it } from "vitest";
import { composerTextareaMaxHeight } from "../../src/client/composer-sizing.js";

describe("composerTextareaMaxHeight", () => {
	it.each([
		{ innerHeight: 844, narrow: true, expected: 219 },
		{ innerHeight: 844, narrow: false, expected: 337 },
		{ innerHeight: 400, narrow: true, expected: 120 },
		{ innerHeight: 400, narrow: false, expected: 160 },
		{ innerHeight: 1000, narrow: true, expected: 260 },
	])("uses the $narrow fraction for $innerHeight px", ({ innerHeight, narrow, expected }) => {
		expect(composerTextareaMaxHeight(innerHeight, narrow)).toBe(expected);
	});

	it.each([undefined, 0])("uses the 800px fallback for an invalid height (%s)", (innerHeight) => {
		expect(composerTextareaMaxHeight(innerHeight, true)).toBe(208);
		expect(composerTextareaMaxHeight(innerHeight, false)).toBe(320);
	});
});
