import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
	/**
	 * Optional callback to resolve the effective service tier when the API
	 * returns a generic tier (e.g. "default") rather than the requested one.
	 * Receives the tier from the response and the tier that was requested.
	 * Should return the tier to use for pricing.
	 */
	resolveServiceTier?: (
		responseTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestedTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"];
	/** Optional callback for non-fatal warnings during streaming (e.g. malformed JSON chunks). */
	onWarning?: (code: string, message: string) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				const filteredContent = !model.input.includes("image")
					? content.filter((c) => c.type !== "input_image")
					: content;
				if (filteredContent.length === 0) continue;
				messages.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	type OpenItem =
		| { kind: "reasoning"; item: ResponseReasoningItem; block: ThinkingContent; contentIndex: number }
		| { kind: "message"; item: ResponseOutputMessage; block: TextContent; contentIndex: number }
		| {
				kind: "function_call";
				item: ResponseFunctionToolCall;
				block: ToolCall & { partialJson?: string };
				contentIndex: number;
				doneArguments?: string;
		  };
	// Output items can overlap (e.g. a message opened before a reasoning item and
	// completed after it, or several function calls open at once). Route every
	// event to the item it identifies rather than to the most recently added one.
	const openItems = new Map<string, OpenItem>();
	const blocks = output.content;
	let receivedResponseCompleted = false;

	const resolveOpenItem = (eventType: string, itemId: string | undefined): OpenItem => {
		if (itemId !== undefined && itemId !== null && itemId !== "") {
			const entry = openItems.get(itemId);
			if (!entry) {
				throw new Error(`Responses stream: ${eventType} references unknown or already completed item "${itemId}"`);
			}
			return entry;
		}
		// Some providers/proxies omit item_id. That is only unambiguous when exactly one item is open.
		if (openItems.size === 1) {
			return openItems.values().next().value as OpenItem;
		}
		throw new Error(
			`Responses stream: ${eventType} has no item_id while ${openItems.size} output items are open; cannot route it unambiguously`,
		);
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning" || item.type === "message" || item.type === "function_call") {
				if (!item.id) {
					throw new Error(`Responses stream: output_item.added for ${item.type} item has no id`);
				}
				if (openItems.has(item.id)) {
					throw new Error(`Responses stream: output_item.added for already open item "${item.id}"`);
				}
			}
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "" };
				output.content.push(block);
				const contentIndex = blocks.length - 1;
				openItems.set(item.id, { kind: "reasoning", item, block, contentIndex });
				stream.push({ type: "thinking_start", contentIndex, partial: output });
			} else if (item.type === "message") {
				const block: TextContent = { type: "text", text: "" };
				output.content.push(block);
				const contentIndex = blocks.length - 1;
				openItems.set(item.id, { kind: "message", item, block, contentIndex });
				stream.push({ type: "text_start", contentIndex, partial: output });
			} else if (item.type === "function_call") {
				const block: ToolCall & { partialJson?: string } = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(block);
				const contentIndex = blocks.length - 1;
				openItems.set(item.id as string, { kind: "function_call", item, block, contentIndex });
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "reasoning") {
				entry.item.summary = entry.item.summary || [];
				entry.item.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "reasoning") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: entry.contentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "reasoning") {
				entry.item.summary = entry.item.summary || [];
				const lastPart = entry.item.summary[entry.item.summary.length - 1];
				if (lastPart) {
					entry.block.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: entry.contentIndex,
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.content_part.added") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "message") {
				entry.item.content = entry.item.content || [];
				// Filter out ReasoningText, only accept output_text and refusal
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					entry.item.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "message") {
				if (!entry.item.content || entry.item.content.length === 0) {
					continue;
				}
				const lastPart = entry.item.content[entry.item.content.length - 1];
				if (lastPart?.type === "output_text") {
					entry.block.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: entry.contentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "message") {
				if (!entry.item.content || entry.item.content.length === 0) {
					continue;
				}
				const lastPart = entry.item.content[entry.item.content.length - 1];
				if (lastPart?.type === "refusal") {
					entry.block.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: entry.contentIndex,
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "function_call") {
				entry.block.partialJson = (entry.block.partialJson ?? "") + event.delta;
				entry.block.arguments = parseStreamingJson(entry.block.partialJson, options?.onWarning);
				stream.push({
					type: "toolcall_delta",
					contentIndex: entry.contentIndex,
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = resolveOpenItem(event.type, event.item_id);
			if (entry.kind === "function_call") {
				entry.doneArguments = event.arguments;
				entry.block.partialJson = event.arguments;
				entry.block.arguments = parseStreamingJson(entry.block.partialJson, options?.onWarning);
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			if (item.type !== "reasoning" && item.type !== "message" && item.type !== "function_call") {
				continue;
			}
			const entry = resolveOpenItem(event.type, item.id);
			if (entry.kind !== item.type) {
				throw new Error(
					`Responses stream: output_item.done for ${item.type} item "${item.id}" does not match open ${entry.kind} item`,
				);
			}
			openItems.delete(item.id as string);

			if (entry.kind === "reasoning" && item.type === "reasoning") {
				entry.block.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
				entry.block.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: entry.contentIndex,
					content: entry.block.thinking,
					partial: output,
				});
			} else if (entry.kind === "message" && item.type === "message") {
				entry.block.text = item.content.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("");
				entry.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: entry.contentIndex,
					content: entry.block.text,
					partial: output,
				});
			} else if (entry.kind === "function_call" && item.type === "function_call") {
				// The identified completion record is authoritative; fall back to this
				// item's own streamed arguments only when the record carries none.
				const rawArgs = item.arguments || entry.doneArguments || entry.block.partialJson || "{}";
				const args = parseStreamingJson(rawArgs, options?.onWarning);
				entry.block.id = `${item.call_id}|${item.id}`;
				entry.block.name = item.name;
				entry.block.arguments = args;
				delete entry.block.partialJson;
				const toolCall: ToolCall = {
					type: "toolCall",
					id: entry.block.id,
					name: entry.block.name,
					arguments: args,
				};
				stream.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			receivedResponseCompleted = true;
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				let serviceTier = response?.service_tier ?? options.serviceTier;
				if (options?.resolveServiceTier) {
					serviceTier = options.resolveServiceTier(response?.service_tier, options.serviceTier);
				}
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			// Map status to stop reason and preserve the provider's incomplete detail
			// so post-retry recovery can distinguish context pressure where possible.
			output.stopReason = mapStopReason(response?.status);
			if (output.stopReason === "length" && response?.incomplete_details?.reason) {
				output.errorMessage = `incomplete: ${response.incomplete_details.reason}`;
			}
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}

	if (!receivedResponseCompleted) {
		throw new Error("Stream ended without response.completed — connection likely dropped");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
