/**
 * Tests for the shared rolling context buffer and event-labeling utilities.
 */
import { describe, expect, it } from "vitest";
import { labelMessageEnd, labelToolEnd, RollingContextBuffer } from "../src/core/context-buffer.js";

describe("RollingContextBuffer", () => {
	it("append adds entries", () => {
		const buf = new RollingContextBuffer();
		buf.append("hello");
		buf.append("world");
		expect(buf.size).toBe(2);
	});

	it("build() joins entries with newline", () => {
		const buf = new RollingContextBuffer();
		buf.append("one");
		buf.append("two");
		buf.append("three");
		expect(buf.build()).toBe("one\ntwo\nthree");
	});

	it("evicts oldest when maxEntries exceeded (default 20)", () => {
		const buf = new RollingContextBuffer();
		for (let i = 0; i < 25; i++) {
			buf.append(`entry-${i}`);
		}
		expect(buf.size).toBe(20);
		// Oldest entries (0-4) should be evicted
		const built = buf.build();
		expect(built).not.toContain("entry-0");
		expect(built).not.toContain("entry-4");
		expect(built).toContain("entry-5");
		expect(built).toContain("entry-24");
	});

	it("evicts oldest with custom maxEntries", () => {
		const buf = new RollingContextBuffer({ maxEntries: 3 });
		buf.append("a");
		buf.append("b");
		buf.append("c");
		buf.append("d");
		expect(buf.size).toBe(3);
		expect(buf.build()).toBe("b\nc\nd");
	});

	it("build() caps total output to maxChars", () => {
		const buf = new RollingContextBuffer({ maxChars: 50 });
		buf.append("a".repeat(30));
		buf.append("b".repeat(30));
		const result = buf.build();
		expect(result.length).toBe(50);
	});

	it("individual entries are capped to 2000 chars", () => {
		const buf = new RollingContextBuffer();
		const longEntry = "x".repeat(5000);
		buf.append(longEntry);
		const result = buf.build();
		expect(result.length).toBe(2000);
	});

	it("clear() empties the buffer", () => {
		const buf = new RollingContextBuffer();
		buf.append("one");
		buf.append("two");
		expect(buf.size).toBe(2);
		buf.clear();
		expect(buf.size).toBe(0);
		expect(buf.build()).toBe("");
	});

	it("size getter reflects entry count", () => {
		const buf = new RollingContextBuffer();
		expect(buf.size).toBe(0);
		buf.append("a");
		expect(buf.size).toBe(1);
		buf.append("b");
		expect(buf.size).toBe(2);
	});
});

describe("labelMessageEnd", () => {
	it("returns [] for non-assistant role messages", () => {
		expect(labelMessageEnd({ role: "user", content: [{ type: "text", text: "hi" }] })).toEqual([]);
		expect(labelMessageEnd({ role: "system", content: [{ type: "text", text: "hi" }] })).toEqual([]);
	});

	it("returns [] for non-array content", () => {
		expect(labelMessageEnd({ role: "assistant", content: "just a string" })).toEqual([]);
		expect(labelMessageEnd({ role: "assistant", content: undefined })).toEqual([]);
		expect(labelMessageEnd({ role: "assistant" })).toEqual([]);
	});

	it("returns ['Assistant: <text>'] for text-only assistant message", () => {
		const result = labelMessageEnd({
			role: "assistant",
			content: [
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world" },
			],
		});
		expect(result).toEqual(["Assistant: Hello world"]);
	});

	it("returns ['Called tools: foo, bar'] for tool-call-only assistant message", () => {
		const result = labelMessageEnd({
			role: "assistant",
			content: [
				{ type: "toolCall", name: "foo" },
				{ type: "toolCall", name: "bar" },
			],
		});
		expect(result).toEqual(["Called tools: foo, bar"]);
	});

	it("returns both entries (text + tools) for mixed content", () => {
		const result = labelMessageEnd({
			role: "assistant",
			content: [
				{ type: "text", text: "Let me help" },
				{ type: "toolCall", name: "bash" },
				{ type: "toolCall", name: "read" },
			],
		});
		expect(result).toEqual(["Assistant: Let me help", "Called tools: bash, read"]);
	});

	it("returns [] when message has no text parts and no tool-call parts", () => {
		const result = labelMessageEnd({
			role: "assistant",
			content: [{ type: "image", url: "https://example.com/img.png" }],
		});
		expect(result).toEqual([]);
	});

	it("caps text at 2000 chars", () => {
		const longText = "x".repeat(3000);
		const result = labelMessageEnd({
			role: "assistant",
			content: [{ type: "text", text: longText }],
		});
		expect(result.length).toBe(1);
		expect(result[0].length).toBe(2000);
	});
});

describe("labelToolEnd", () => {
	it("returns 'Tool bash completed' for success with no output", () => {
		expect(labelToolEnd({ toolName: "bash" })).toBe("Tool bash completed");
	});

	it("returns 'Tool bash failed' for error with no output", () => {
		expect(labelToolEnd({ toolName: "bash", isError: true })).toBe("Tool bash failed");
	});

	it("returns 'Tool bash completed: <text>' for string output", () => {
		const result = labelToolEnd({ toolName: "bash", result: { output: "hello world" } });
		expect(result).toBe("Tool bash completed: hello world");
	});

	it("returns 'Tool bash completed: <text>' for array-of-content output", () => {
		const result = labelToolEnd({
			toolName: "bash",
			result: {
				content: [
					{ type: "text", text: "line 1\n" },
					{ type: "text", text: "line 2" },
				],
			},
		});
		expect(result).toBe("Tool bash completed: line 1\nline 2");
	});

	it("returns 'Tool bash failed: <error>' for error with output", () => {
		const result = labelToolEnd({
			toolName: "bash",
			isError: true,
			result: { output: "command not found" },
		});
		expect(result).toBe("Tool bash failed: command not found");
	});
});
