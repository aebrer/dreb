import { describe, expect, it } from "vitest";
import { extractSendFiles } from "../src/util/files.js";
import { truncate } from "../src/util/telegram.js";

describe("truncate", () => {
	it("returns short text unchanged", () => {
		expect(truncate("hello", 100)).toBe("hello");
	});

	it("truncates long text with marker", () => {
		const long = "a".repeat(200);
		const result = truncate(long, 100);
		expect(result.length).toBeLessThanOrEqual(100);
		expect(result).toContain("_(truncated)_");
	});
});

describe("extractSendFiles", () => {
	it("extracts file paths from markers", () => {
		const text = "Here is the file: [[telegram:send:/tmp/test.pdf]] done.";
		const [cleaned, paths] = extractSendFiles(text);
		expect(paths).toEqual(["/tmp/test.pdf"]);
		expect(cleaned).toBe("Here is the file:  done.");
	});

	it("handles multiple markers", () => {
		const text = "[[telegram:send:/a.txt]] and [[telegram:send:/b.txt]]";
		const [cleaned, paths] = extractSendFiles(text);
		expect(paths).toEqual(["/a.txt", "/b.txt"]);
		expect(cleaned).toBe("and");
	});

	it("returns empty array when no markers", () => {
		const [cleaned, paths] = extractSendFiles("no files here");
		expect(paths).toEqual([]);
		expect(cleaned).toBe("no files here");
	});

	it("handles paths with spaces", () => {
		const text = "[[telegram:send:/tmp/my file.pdf]]";
		const [_, paths] = extractSendFiles(text);
		expect(paths).toEqual(["/tmp/my file.pdf"]);
	});
});
