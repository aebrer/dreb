import type { AssistantMessage, ToolResultMessage, UserMessage } from "@dreb/ai";
import { describe, expect, test } from "vitest";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
} from "../src/core/messages.js";
import { extractCopyableText, getMessagePreview, getMessageRoleLabel } from "../src/utils/message-text.js";

// --- Helpers for creating test messages ---

function makeUserMessage(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeToolResult(toolName: string, content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content,
		isError: false,
		timestamp: Date.now(),
	};
}

function makeBashExecution(command: string, output: string): BashExecutionMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now(),
	};
}

function makeBranchSummary(summary: string): BranchSummaryMessage {
	return { role: "branchSummary", summary, fromId: "branch-1", timestamp: Date.now() };
}

function makeCompactionSummary(summary: string): CompactionSummaryMessage {
	return { role: "compactionSummary", summary, tokensBefore: 5000, timestamp: Date.now() };
}

function makeCustomMessage(customType: string, content: CustomMessage["content"]): CustomMessage {
	return { role: "custom", customType, content, display: true, timestamp: Date.now() };
}

// --- extractCopyableText tests ---

describe("extractCopyableText", () => {
	describe("user messages", () => {
		test("string content", () => {
			const msg = makeUserMessage("Hello, world!");
			expect(extractCopyableText(msg)).toBe("Hello, world!");
		});

		test("TextContent array", () => {
			const msg = makeUserMessage([
				{ type: "text", text: "First part" },
				{ type: "text", text: "Second part" },
			]);
			expect(extractCopyableText(msg)).toBe("First part\nSecond part");
		});

		test("mixed text + image content (images skipped)", () => {
			const msg = makeUserMessage([
				{ type: "text", text: "Some text" },
				{ type: "image", data: "base64data", mimeType: "image/png" },
				{ type: "text", text: "More text" },
			]);
			expect(extractCopyableText(msg)).toBe("Some text\nMore text");
		});

		test("only image content returns empty string", () => {
			const msg = makeUserMessage([{ type: "image", data: "base64data", mimeType: "image/png" }]);
			expect(extractCopyableText(msg)).toBe("");
		});
	});

	describe("assistant messages", () => {
		test("single text block", () => {
			const msg = makeAssistantMessage([{ type: "text", text: "Hello from assistant" }]);
			expect(extractCopyableText(msg)).toBe("Hello from assistant");
		});

		test("multiple text blocks", () => {
			const msg = makeAssistantMessage([
				{ type: "text", text: "First response" },
				{ type: "text", text: "Second response" },
			]);
			expect(extractCopyableText(msg)).toBe("First response\nSecond response");
		});

		test("thinking blocks included with header", () => {
			const msg = makeAssistantMessage([
				{ type: "text", text: "Visible reply" },
				{ type: "thinking", thinking: "Internal reasoning here" },
			]);
			expect(extractCopyableText(msg)).toBe("Visible reply\n[thinking]\nInternal reasoning here");
		});

		test("multiple thinking blocks each get header", () => {
			const msg = makeAssistantMessage([
				{ type: "thinking", thinking: "Step 1" },
				{ type: "text", text: "Answer" },
				{ type: "thinking", thinking: "Step 2" },
			]);
			expect(extractCopyableText(msg)).toBe("Answer\n[thinking]\nStep 1\n[thinking]\nStep 2");
		});

		test("toolCall blocks are skipped", () => {
			const msg = makeAssistantMessage([
				{ type: "text", text: "I will use a tool" },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "foo.ts" } },
			]);
			expect(extractCopyableText(msg)).toBe("I will use a tool");
		});

		test("empty content returns empty string", () => {
			const msg = makeAssistantMessage([]);
			expect(extractCopyableText(msg)).toBe("");
		});

		test("only toolCall blocks returns empty string", () => {
			const msg = makeAssistantMessage([
				{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
			]);
			expect(extractCopyableText(msg)).toBe("");
		});
	});

	describe("tool result messages", () => {
		test("text content with tool name header", () => {
			const msg = makeToolResult("read", [{ type: "text", text: "file contents here" }]);
			expect(extractCopyableText(msg)).toBe("[read]\nfile contents here");
		});

		test("image-only content returns empty string", () => {
			const msg = makeToolResult("screenshot", [{ type: "image", data: "base64data", mimeType: "image/png" }]);
			expect(extractCopyableText(msg)).toBe("");
		});

		test("mixed content (text extracted, images skipped)", () => {
			const msg = makeToolResult("bash", [
				{ type: "text", text: "output line 1" },
				{ type: "image", data: "base64data", mimeType: "image/png" },
				{ type: "text", text: "output line 2" },
			]);
			expect(extractCopyableText(msg)).toBe("[bash]\noutput line 1\noutput line 2");
		});
	});

	describe("bash execution messages", () => {
		test("command with output", () => {
			const msg = makeBashExecution("ls -la", "total 42\ndrwxr-xr-x 5 user");
			expect(extractCopyableText(msg)).toBe("$ ls -la\ntotal 42\ndrwxr-xr-x 5 user");
		});

		test("command with empty output", () => {
			const msg = makeBashExecution("mkdir test", "");
			expect(extractCopyableText(msg)).toBe("$ mkdir test\n");
		});
	});

	describe("branch summary messages", () => {
		test("returns summary text", () => {
			const msg = makeBranchSummary("Explored authentication approach but reverted");
			expect(extractCopyableText(msg)).toBe("Explored authentication approach but reverted");
		});
	});

	describe("compaction summary messages", () => {
		test("returns summary text", () => {
			const msg = makeCompactionSummary("Discussed project setup and installed dependencies");
			expect(extractCopyableText(msg)).toBe("Discussed project setup and installed dependencies");
		});
	});

	describe("custom messages", () => {
		test("string content", () => {
			const msg = makeCustomMessage("notification", "Extension loaded successfully");
			expect(extractCopyableText(msg)).toBe("Extension loaded successfully");
		});

		test("array content", () => {
			const msg = makeCustomMessage("info", [
				{ type: "text", text: "Status: ready" },
				{ type: "text", text: "Version: 1.0" },
			]);
			expect(extractCopyableText(msg)).toBe("Status: ready\nVersion: 1.0");
		});
	});
});

// --- getMessageRoleLabel tests ---

describe("getMessageRoleLabel", () => {
	test("user → 'You'", () => {
		expect(getMessageRoleLabel(makeUserMessage("hi"))).toBe("You");
	});

	test("assistant → 'Assistant'", () => {
		expect(getMessageRoleLabel(makeAssistantMessage([]))).toBe("Assistant");
	});

	test("toolResult → 'Tool: <name>'", () => {
		expect(getMessageRoleLabel(makeToolResult("read", []))).toBe("Tool: read");
		expect(getMessageRoleLabel(makeToolResult("bash", []))).toBe("Tool: bash");
	});

	test("bashExecution → 'Bash'", () => {
		expect(getMessageRoleLabel(makeBashExecution("ls", ""))).toBe("Bash");
	});

	test("branchSummary → 'Branch'", () => {
		expect(getMessageRoleLabel(makeBranchSummary("summary"))).toBe("Branch");
	});

	test("compactionSummary → 'Summary'", () => {
		expect(getMessageRoleLabel(makeCompactionSummary("summary"))).toBe("Summary");
	});

	test("custom → 'Custom: <type>'", () => {
		expect(getMessageRoleLabel(makeCustomMessage("myext", "content"))).toBe("Custom: myext");
	});
});

// --- getMessagePreview tests ---

describe("getMessagePreview", () => {
	test("returns first line content normalized", () => {
		const msg = makeUserMessage("First line\nSecond line\nThird line");
		expect(getMessagePreview(msg)).toBe("First line Second line Third line");
	});

	test("truncates to 200 chars", () => {
		const longText = "x".repeat(300);
		const msg = makeUserMessage(longText);
		const preview = getMessagePreview(msg);
		expect(preview.length).toBe(200);
		expect(preview).toBe("x".repeat(200));
	});

	test("returns '[no text content]' for image-only messages", () => {
		const msg = makeUserMessage([{ type: "image", data: "base64data", mimeType: "image/png" }]);
		expect(getMessagePreview(msg)).toBe("[no text content]");
	});

	test("returns '[no text content]' for empty assistant", () => {
		const msg = makeAssistantMessage([]);
		expect(getMessagePreview(msg)).toBe("[no text content]");
	});

	test("collapses multiple whitespace", () => {
		const msg = makeUserMessage("hello   world\n\n\ntest");
		expect(getMessagePreview(msg)).toBe("hello world test");
	});

	test("trims leading/trailing whitespace", () => {
		const msg = makeUserMessage("  padded content  ");
		expect(getMessagePreview(msg)).toBe("padded content");
	});
});
