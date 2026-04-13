import { describe, expect, it, vi } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.js";

describe("parseStreamingJson", () => {
	it("returns empty object for undefined input", () => {
		expect(parseStreamingJson(undefined)).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseStreamingJson("")).toEqual({});
	});

	it("returns empty object for whitespace-only string", () => {
		expect(parseStreamingJson("   \n\t  ")).toEqual({});
	});

	it("parses valid complete JSON", () => {
		const result = parseStreamingJson('{"name": "test", "value": 42}');
		expect(result).toEqual({ name: "test", value: 42 });
	});

	it("parses partial/incomplete JSON via partial-json", () => {
		const result = parseStreamingJson('{"name": "te');
		expect(result).toEqual({ name: "te" });
	});

	it("returns empty object for totally unparseable input", () => {
		expect(parseStreamingJson("<<<not json at all>>>")).toEqual({});
	});

	it("calls onWarning when both parsers fail", () => {
		const onWarning = vi.fn();
		const result = parseStreamingJson("<<<not json at all>>>", onWarning);
		expect(result).toEqual({});
		expect(onWarning).toHaveBeenCalledOnce();
		expect(onWarning).toHaveBeenCalledWith(
			"json_parse_total_failure",
			expect.stringContaining("<<<not json at all>>>"),
		);
	});

	it("does not call onWarning for valid JSON", () => {
		const onWarning = vi.fn();
		parseStreamingJson('{"ok": true}', onWarning);
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("does not call onWarning for partial JSON", () => {
		const onWarning = vi.fn();
		parseStreamingJson('{"name": "te', onWarning);
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("does not throw when onWarning is not provided and input is garbage", () => {
		expect(() => parseStreamingJson("<<<not json at all>>>")).not.toThrow();
	});
});
