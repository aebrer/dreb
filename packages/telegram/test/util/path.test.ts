import { describe, expect, it } from "vitest";
import { resolveNewPath } from "../../src/util/path.js";

const fakeHome = "/home/testuser";

function resolve(input: string) {
	return resolveNewPath(input, () => fakeHome);
}

describe("resolveNewPath", () => {
	describe("explicit paths", () => {
		it("expands ~ to home directory", () => {
			expect(resolve("~/projects")).toBe("/home/testuser/projects");
		});

		it("keeps absolute paths unchanged", () => {
			expect(resolve("/usr/local/bin")).toBe("/usr/local/bin");
		});

		it("resolves relative paths containing a slash", () => {
			expect(resolve("./relative")).toMatch(/\/relative$/);
		});

		it("resolves slash-separated paths as a single path", () => {
			expect(resolve("projects/dreb")).toMatch(/\/projects\/dreb$/);
		});

		it("does not apply shorthand when the argument contains a slash", () => {
			expect(resolve("foo/bar baz")).toMatch(/\/foo\/bar baz$/);
		});
	});

	describe("shorthand paths", () => {
		it("treats space-separated tokens as home-relative segments", () => {
			expect(resolve("projects dreb")).toBe("/home/testuser/projects/dreb");
		});

		it("supports a single bare token", () => {
			expect(resolve("documents")).toBe("/home/testuser/documents");
		});

		it("respects double-quoted spans as a single segment", () => {
			expect(resolve('"My Projects" dreb')).toBe("/home/testuser/My Projects/dreb");
		});

		it("handles multiple quoted segments", () => {
			expect(resolve('"My Projects" "deep yellow"')).toBe("/home/testuser/My Projects/deep yellow");
		});

		it("ignores extra whitespace between tokens", () => {
			expect(resolve("projects   dreb")).toBe("/home/testuser/projects/dreb");
		});

		it("keeps inner spaces inside a quoted segment", () => {
			expect(resolve('"a b c" d')).toBe("/home/testuser/a b c/d");
		});

		it("preserves unclosed quotes as literal text", () => {
			expect(resolve('"My Projects')).toBe("/home/testuser/My Projects");
		});

		it("ignores empty quoted segments", () => {
			expect(resolve('"" projects')).toBe("/home/testuser/projects");
		});
	});

	describe("edge cases", () => {
		it("trims leading and trailing whitespace", () => {
			expect(resolve("  projects dreb  ")).toBe("/home/testuser/projects/dreb");
		});

		it("throws on empty input", () => {
			expect(() => resolve("")).toThrow();
		});
	});
});
