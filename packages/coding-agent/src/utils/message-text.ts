/**
 * Utilities for extracting copyable plain text from AgentMessages.
 * Used by the copy selector modal to present message content for clipboard copy.
 */

import type { AgentMessage } from "@dreb/agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from "@dreb/ai";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
} from "../core/messages.js";

/**
 * Extract copyable plain text from any AgentMessage.
 * Returns the original source text without any terminal wrapping or ANSI codes.
 * Returns empty string for messages with no meaningful text content (e.g., image-only).
 */
export function extractCopyableText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return extractUserText(message);
		case "assistant":
			return extractAssistantText(message);
		case "toolResult":
			return extractToolResultText(message);
		case "bashExecution":
			return extractBashText(message);
		case "branchSummary":
			return (message as BranchSummaryMessage).summary;
		case "compactionSummary":
			return (message as CompactionSummaryMessage).summary;
		case "custom":
			return extractCustomText(message as CustomMessage);
		default:
			return "";
	}
}

/**
 * Get a short label for a message's role (used in the copy selector UI).
 */
export function getMessageRoleLabel(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return "You";
		case "assistant":
			return "Assistant";
		case "toolResult":
			return `Tool: ${(message as ToolResultMessage).toolName}`;
		case "bashExecution":
			return "Bash";
		case "branchSummary":
			return "Branch";
		case "compactionSummary":
			return "Summary";
		case "custom":
			return `Custom: ${(message as CustomMessage).customType}`;
		default:
			return "Unknown";
	}
}

/**
 * Extract the thinking/reasoning text from a message, if any.
 * Only assistant messages carry thinking blocks. Returns a single labeled block
 * (`[thinking]\n<reasoning>`) suitable for copying, or an empty string when there
 * is no thinking content (non-assistant role, or assistant with no thinking blocks).
 */
export function extractThinkingText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	const thinkingParts = (message as AssistantMessage).content
		.filter(
			(block): block is { type: "thinking"; thinking: string } => block.type === "thinking" && "thinking" in block,
		)
		.map((block) => block.thinking);

	if (thinkingParts.length === 0) {
		return "";
	}
	return `[thinking]\n${thinkingParts.join("\n\n")}`;
}

/**
 * Normalize text to a single-line preview: collapse whitespace, trim, truncate to ~200 chars.
 * Caller handles further width truncation for display. Returns "[no text content]" for empty input.
 */
export function toSingleLinePreview(text: string): string {
	if (!text) {
		return "[no text content]";
	}
	// Normalize to single line: replace newlines with spaces, collapse whitespace
	const singleLine = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
	if (singleLine.length <= 200) {
		return singleLine;
	}
	return singleLine.slice(0, 200);
}

/**
 * Get a single-line preview of a message's content (for display in selector).
 * Returns plain text, no ANSI, truncated to ~200 chars. Caller handles width truncation.
 */
export function getMessagePreview(message: AgentMessage): string {
	return toSingleLinePreview(extractCopyableText(message));
}

// --- Internal helpers ---

function extractTextBlocks(content: (TextContent | { type: string })[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractUserText(message: UserMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return extractTextBlocks(message.content);
}

function extractAssistantText(message: AssistantMessage): string {
	// Only visible text blocks. Thinking is excluded by default and surfaced
	// separately via extractThinkingText (see issue 285).
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractToolResultText(message: ToolResultMessage): string {
	const textContent = extractTextBlocks(message.content);
	if (!textContent) {
		return "";
	}
	return `[${message.toolName}]\n${textContent}`;
}

function extractBashText(message: BashExecutionMessage): string {
	return `$ ${message.command}\n${message.output}`;
}

function extractCustomText(message: CustomMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return extractTextBlocks(message.content);
	}
	return "";
}
