/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	DEFAULT_MAX_OUTPUT_TOKENS,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@dreb/ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start", model: { provider: config.model.provider, id: config.model.id } });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start", model: { provider: config.model.provider, id: config.model.id } });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	let endTurnRequested = false;
	let llmCallCount = 0;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;
		endTurnRequested = false;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// Process pending messages first (inject into context so they're never lost).
			// This happens before turn_start and shouldContinue so messages are always
			// preserved regardless of whether the turn proceeds.
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Check shouldContinue before starting a new turn (not the very first).
			// This runs before turn_start so we never emit an orphaned turn_start.
			if (llmCallCount > 0 && config.shouldContinue && !config.shouldContinue()) {
				break;
			}

			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);
			llmCallCount++;

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const executionResult = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executionResult.results);

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				if (executionResult.endTurn) {
					endTurnRequested = true;
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			// If a tool requested endTurn, stop the loop (skip further LLM calls)
			if (endTurnRequested) {
				hasMoreToolCalls = false;
				pendingMessages = [];
				break;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Drain any steering messages that arrived during
		// wind-down (e.g., background agent results delivered via steer() between
		// endTurn break and here). Then check for follow-up messages.
		const leftoverSteering = (await config.getSteeringMessages?.()) || [];
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		const allPending = [...leftoverSteering, ...followUpMessages];
		if (allPending.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = allPending;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Check if an error is a stream-drop error (connection dropped before terminal event).
 * Only these errors trigger automatic retry — all other errors propagate as-is.
 */
function isStreamDropError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return (
		msg.includes("Stream ended without") ||
		msg.includes("connection likely dropped") ||
		msg.includes("WebSocket stream closed before")
	);
}

/**
 * Sleep for a duration, aborting early if the signal fires.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const streamStart = performance.now();
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	const finalizeMessage = async (finalMessage: AssistantMessage): Promise<AssistantMessage> => {
		finalMessage.durationMs = Math.max(0, performance.now() - streamStart);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
		}
		if (!addedPartial) {
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	};

	const createErrorMessage = (error: unknown): AssistantMessage => ({
		role: "assistant",
		content: partialMessage?.content ?? [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: partialMessage?.usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: partialMessage?.timestamp ?? Date.now(),
	});

	const maxRetries = config.streamRetries ?? 3;
	const retryBaseDelay = config.streamRetryBaseDelayMs ?? 1000;
	const lengthRetries = config.lengthRetries ?? 2;
	const lengthMultiplier = config.lengthRetryBudgetMultiplier ?? 2;
	// The maxTokens budget requested for the current attempt. Starts at the
	// caller-configured budget (may be undefined → provider default) and is
	// escalated on each length retry. Kept separate from stream-drop retries.
	let requestMaxTokens = config.maxTokens;
	let lengthAttempts = 0;
	const clonePartialForDebug = (): AssistantMessage | undefined => {
		if (!partialMessage) return undefined;
		return {
			...partialMessage,
			content: partialMessage.content.map((block) => ({ ...block })),
			usage: { ...partialMessage.usage, cost: { ...partialMessage.usage.cost } },
		};
	};

	// Discard the truncated partial message (if any) before re-issuing a request.
	const discardPartial = () => {
		if (addedPartial) {
			context.messages.pop();
			addedPartial = false;
		}
		partialMessage = null;
	};

	// Compute the escalated token budget for a length retry, never exceeding the
	// model's ceiling. `current` is the *effective* budget that produced the
	// truncated response (resolved from the provider default when no explicit
	// maxTokens was set), so the escalation always requests strictly more.
	const escalateLengthBudget = (current: number): number => {
		const ceiling = config.model.maxTokens;
		return Math.min(Math.ceil(current * lengthMultiplier), ceiling);
	};

	// Build the truncation failure message after length retries are exhausted.
	const createLengthExhaustedMessage = (attempts: number): AssistantMessage => {
		const errorMessage = createErrorMessage(
			new Error(
				`Response truncated at token limit after ${attempts} attempt${attempts === 1 ? "" : "s"} — output exceeded the model's maximum token budget`,
			),
		);
		// Force "error" so the runLoop error guard terminates the turn loudly.
		errorMessage.stopReason = signal?.aborted ? "aborted" : "error";
		return errorMessage;
	};

	// stream-drop retries are counted separately from length retries. A length retry
	// is a fresh request, so it resets the stream-drop attempt counter.
	let streamDropAttempt = 0;
	while (true) {
		let response: Awaited<ReturnType<StreamFn>>;
		try {
			response = await streamFunction(config.model, llmContext, {
				...config,
				maxTokens: requestMaxTokens,
				apiKey: resolvedApiKey,
				signal,
			});
		} catch (error) {
			if (isStreamDropError(error) && streamDropAttempt < maxRetries && !signal?.aborted) {
				await emit({
					type: "stream_retry",
					attempt: streamDropAttempt + 1,
					maxAttempts: maxRetries,
					error: error instanceof Error ? error.message : String(error),
					discardedPartial: clonePartialForDebug(),
				});
				await sleep(retryBaseDelay * 2 ** streamDropAttempt, signal);
				discardPartial();
				streamDropAttempt++;
				continue;
			}
			const surfacedError = isStreamDropError(error)
				? new Error("Stream dropped repeatedly — connection likely unstable")
				: error instanceof Error
					? error
					: new Error(String(error));
			return finalizeMessage(createErrorMessage(surfacedError));
		}

		let shouldRetry = false;
		let retryError = "";
		// Set when the stream completes with a "length" result that warrants a budget escalation.
		let lengthRetry: { previous: number; next: number } | null = null;
		try {
			for await (const event of response) {
				switch (event.type) {
					case "start":
						partialMessage = event.partial;
						context.messages.push(partialMessage);
						addedPartial = true;
						await emit({ type: "message_start", message: { ...partialMessage } });
						break;

					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						if (partialMessage) {
							partialMessage = event.partial;
							context.messages[context.messages.length - 1] = partialMessage;
							await emit({
								type: "message_update",
								assistantMessageEvent: event,
								message: { ...partialMessage },
							});
						}
						break;

					case "done":
					case "error": {
						const result = await response.result();
						// Check if this is a stream-drop error that should be retried
						const isDrop = result.stopReason === "error" && isStreamDropError(result.errorMessage);
						if (isDrop && streamDropAttempt < maxRetries && !signal?.aborted) {
							shouldRetry = true;
							retryError =
								result.errorMessage ?? "Stream ended without terminal event — connection likely dropped";
						} else if (isDrop) {
							// Final attempt exhausted — surface friendly message
							return finalizeMessage(
								createErrorMessage(new Error("Stream dropped repeatedly — connection likely unstable")),
							);
						} else if (result.stopReason === "length") {
							// The model exhausted its output budget mid-response. Retry with a
							// larger budget if we have retries left, the budget can still grow,
							// and we have not been aborted. Otherwise, fail loudly below.
							//
							// When no explicit maxTokens was set, the request used the provider
							// default budget — Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS),
							// NOT the full model ceiling. Resolving the effective budget to the
							// real default lets escalation request strictly more, and lets the
							// ceiling guard correctly distinguish a default request (which can
							// still grow) from one already at the model ceiling.
							const effectiveMaxTokens =
								requestMaxTokens ?? Math.min(config.model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
							const atCeiling = effectiveMaxTokens >= config.model.maxTokens;
							if (lengthAttempts < lengthRetries && !atCeiling && !signal?.aborted) {
								lengthRetry = {
									previous: effectiveMaxTokens,
									next: escalateLengthBudget(effectiveMaxTokens),
								};
							} else {
								return finalizeMessage(createLengthExhaustedMessage(lengthAttempts + 1));
							}
						} else {
							return finalizeMessage(result);
						}
						break;
					}
				}
				if (shouldRetry || lengthRetry) break;
			}
		} catch (error) {
			if (isStreamDropError(error) && streamDropAttempt < maxRetries && !signal?.aborted) {
				shouldRetry = true;
				retryError = error instanceof Error ? error.message : String(error);
			} else {
				const surfacedError = isStreamDropError(error)
					? new Error("Stream dropped repeatedly — connection likely unstable")
					: error instanceof Error
						? error
						: new Error(String(error));
				return finalizeMessage(createErrorMessage(surfacedError));
			}
		}

		if (lengthRetry) {
			await emit({
				type: "length_retry",
				attempt: lengthAttempts + 1,
				maxAttempts: lengthRetries,
				previousMaxTokens: lengthRetry.previous,
				nextMaxTokens: lengthRetry.next,
				discardedPartial: clonePartialForDebug(),
			});
			discardPartial();
			requestMaxTokens = lengthRetry.next;
			lengthAttempts++;
			// A length retry is a fresh request; reset the stream-drop counter.
			streamDropAttempt = 0;
			continue;
		}

		if (shouldRetry) {
			await emit({
				type: "stream_retry",
				attempt: streamDropAttempt + 1,
				maxAttempts: maxRetries,
				error: retryError,
				discardedPartial: clonePartialForDebug(),
			});
			await sleep(retryBaseDelay * 2 ** streamDropAttempt, signal);
			discardPartial();
			streamDropAttempt++;
			continue;
		}

		return finalizeMessage(await response.result());
	}
}

interface ToolExecutionResult {
	results: ToolResultMessage[];
	endTurn: boolean;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolExecutionResult> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolExecutionResult> {
	const results: ToolResultMessage[] = [];
	let endTurn = false;

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			if (preparation.result.endTurn) endTurn = true;
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			if (executed.result.endTurn) endTurn = true;
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return { results, endTurn };
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolExecutionResult> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];
	let endTurn = false;

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			if (preparation.result.endTurn) endTurn = true;
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		if (executed.result.endTurn) endTurn = true;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return { results, endTurn };
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const validatedArgs = validateToolArguments(tool, toolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
