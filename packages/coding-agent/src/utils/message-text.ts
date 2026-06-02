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
 * Get a single-line preview of a message's content (for display in selector).
 * Returns plain text, no ANSI, truncated to ~200 chars. Caller handles width truncation.
 */
export function getMessagePreview(message: AgentMessage): string {
	const text = extractCopyableText(message);
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
	const parts: string[] = [];

	// Collect text blocks
	const textParts = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text);

	if (textParts.length > 0) {
		parts.push(textParts.join("\n"));
	}

	// Collect thinking blocks with header
	for (const block of message.content) {
		if (block.type === "thinking" && "thinking" in block) {
			parts.push(`[thinking]\n${block.thinking}`);
		}
	}

	return parts.join("\n");
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
