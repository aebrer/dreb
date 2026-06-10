/**
 * Shared rolling context buffer and event-labeling utilities.
 *
 * Extracted from buddy-controller.ts so that both the buddy companion and
 * other consumers (e.g. tab-title updater) can reuse the same content-extraction
 * and buffer management logic without duplication.
 */

/**
 * A fixed-capacity ring buffer that stores labeled context entries.
 * Entries are capped individually and the built output is capped to a total character limit.
 */
export class RollingContextBuffer {
	private entries: string[] = [];
	private readonly maxEntries: number;
	private readonly maxChars: number;

	constructor(opts?: { maxEntries?: number; maxChars?: number }) {
		this.maxEntries = opts?.maxEntries ?? 20;
		this.maxChars = opts?.maxChars ?? 8000;
	}

	/** Append an entry to the buffer (evicts oldest if at capacity). Individual entries are capped to 2000 chars. */
	append(entry: string): void {
		this.entries.push(entry.slice(0, 2000));
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
	}

	/** Clear all entries from the buffer. */
	clear(): void {
		this.entries = [];
	}

	/** Join all entries with newlines, capped to maxChars total. Newest entries are preferred. */
	build(): string {
		const joined = this.entries.join("\n");
		return joined.length <= this.maxChars ? joined : joined.slice(-this.maxChars);
	}

	/** Current number of entries in the buffer. */
	get size(): number {
		return this.entries.length;
	}
}

/**
 * Label an assistant message_end event into 0-2 context entries.
 *
 * Returns labeled strings for text content and/or tool calls.
 * Returns [] for non-assistant messages or messages with no usable content.
 */
export function labelMessageEnd(message: { role: string; content?: unknown }): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return [];
	}

	const results: string[] = [];

	const textParts = message.content
		?.filter((c: any) => c.type === "text")
		?.map((c: any) => c.text)
		?.join("");

	if (textParts) {
		results.push(`Assistant: ${textParts}`.slice(0, 2000));
	}

	const toolCalls = message.content?.filter((c: any) => c.type === "toolCall") ?? [];
	if (toolCalls.length > 0) {
		const tools = toolCalls.map((c: any) => c.name).join(", ");
		results.push(`Called tools: ${tools}`);
	}

	return results;
}

/**
 * Label a tool_execution_end event into a single context entry.
 *
 * Returns a string like "Tool bash completed" or "Tool bash failed: <output>".
 */
export function labelToolEnd(event: { toolName: string; isError?: boolean; result?: unknown }): string {
	const output = (event.result as any)?.output || (event.result as any)?.content;
	const outputText =
		typeof output === "string"
			? output
			: Array.isArray(output)
				? output
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("")
				: "";
	const status = event.isError ? "failed" : "completed";
	return `Tool ${event.toolName} ${status}${outputText ? `: ${outputText}` : ""}`;
}
