import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool } from "@dreb/agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	findModel,
	type Model,
} from "@dreb/ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
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
		...overrides,
	};
}

type SessionWithExtensionEmitHook = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
	_extensionRunner?: {
		hasExtensions: boolean;
		hasHandlers: (eventType: string) => boolean;
		emit: (event: { type: string; [key: string]: unknown }) => Promise<void>;
		emitBeforeAgentStart: () => Promise<undefined>;
	};
};

describe("AgentSession retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-retry-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(options?: {
		failCount?: number;
		maxRetries?: number;
		delayAssistantMessageEndMs?: number;
		failure?: Partial<AssistantMessage>;
		/** Scripted results by call order; calls beyond the script succeed. Replaces failCount/failure. */
		responses?: Partial<AssistantMessage>[];
		model?: Model<Api>;
		compactionReserveTokens?: number;
	}) {
		const responses = options?.responses;
		const failCount = responses ? 0 : (options?.failCount ?? 1);
		const maxRetries = options?.maxRetries ?? 3;
		const delayAssistantMessageEndMs = options?.delayAssistantMessageEndMs ?? 0;
		const failure = options?.failure ?? { errorMessage: "overloaded_error" };
		let callCount = 0;

		const model = options?.model ?? findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const scripted = responses?.[callCount - 1];
					const msg = scripted
						? createAssistantMessage("", scripted)
						: callCount <= failCount
							? createAssistantMessage("", { stopReason: "error", ...failure })
							: createAssistantMessage("Success");
					stream.push({ type: "start", partial: msg });
					if (msg.stopReason === "error" || msg.stopReason === "aborted") {
						stream.push({ type: "error", reason: msg.stopReason, error: msg });
					} else {
						stream.push({ type: "done", reason: msg.stopReason, message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });
		if (options?.compactionReserveTokens !== undefined) {
			settingsManager.applyOverrides({
				compaction: { enabled: true, reserveTokens: options.compactionReserveTokens },
			});
		}

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		if (delayAssistantMessageEndMs > 0) {
			const sessionWithHook = session as unknown as SessionWithExtensionEmitHook;
			const original = sessionWithHook._emitExtensionEvent.bind(sessionWithHook);
			sessionWithHook._emitExtensionEvent = async (event: AgentEvent) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					await new Promise((resolve) => setTimeout(resolve, delayAssistantMessageEndMs));
				}
				await original(event);
			};
		}

		return { session, getCallCount: () => callCount };
	}

	it("retries after a transient error and succeeds", async () => {
		const created = createSession({ failCount: 1 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(created.session.isRetrying).toBe(false);
	});

	describe("safety refusals", () => {
		// Matches the retry regex ("terminated", "timed out") and an overflow pattern
		// ("prompt is too long"): only the structured refusal marker may stop recovery.
		const explanation = "This conversation was terminated because the prompt is too long and the review timed out.";
		const errorMessage = `Request declined by the model's safety filter (category: cyber): ${explanation}`;

		function recordRecovery(target: AgentSession): string[] {
			const events: string[] = [];
			target.subscribe((event) => {
				if (event.type === "auto_retry_start") events.push(`retry-start:${event.attempt}`);
				if (event.type === "auto_retry_end") events.push(`retry-end:success=${event.success}`);
				if (event.type === "auto_compaction_start") events.push(`compaction-start:${event.reason}`);
			});
			return events;
		}

		it("never auto-retries or compacts a refusal, whatever its explanation says", async () => {
			// Same provider/model as the session so the overflow-compaction path is reachable.
			const model = findModel("anthropic", "sonnet")!;
			const created = createSession({
				failCount: 1,
				failure: {
					provider: model.provider,
					model: model.id,
					errorMessage,
					refusal: { category: "cyber", explanation },
				},
			});
			const events = recordRecovery(created.session);

			await created.session.prompt("Test");

			expect(created.getCallCount()).toBe(1);
			expect(events).toEqual([]);
			expect(created.session.isRetrying).toBe(false);
			const last = created.session.messages.at(-1) as AssistantMessage;
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(errorMessage);
			expect(last.refusal).toEqual({ category: "cyber", explanation });
		});

		it("still retries the same retryable wording without the refusal marker", async () => {
			const created = createSession({
				failCount: 1,
				failure: { errorMessage: `Upstream ${explanation.replace("the prompt is too long and ", "")}` },
			});
			const events = recordRecovery(created.session);

			await created.session.prompt("Test");

			expect(created.getCallCount()).toBe(2);
			expect(events).toEqual(["retry-start:1", "retry-end:success=true"]);
		});

		it("closes the retry cycle when the retried request is refused, and resets the retry budget", async () => {
			const refusal = { category: "cyber", explanation };
			const created = createSession({
				responses: [
					{ stopReason: "error", errorMessage: "overloaded_error" },
					{ stopReason: "error", errorMessage, refusal },
					{ stopReason: "error", errorMessage: "overloaded_error" },
				],
			});
			const events = recordRecovery(created.session);
			const retryEnds: unknown[] = [];
			created.session.subscribe((event) => {
				if (event.type === "auto_retry_end") retryEnds.push(event);
			});

			await created.session.prompt("Test");

			// The 529 is retried once; the refused retry is final and ends the cycle as a failure.
			expect(created.getCallCount()).toBe(2);
			expect(events).toEqual(["retry-start:1", "retry-end:success=false"]);
			expect(retryEnds).toEqual([{ type: "auto_retry_end", success: false, attempt: 1, finalError: errorMessage }]);
			expect(created.session.isRetrying).toBe(false);
			const last = created.session.messages.at(-1) as AssistantMessage;
			expect(last.refusal).toEqual(refusal);

			// The next transient error starts a fresh retry cycle at attempt 1.
			await created.session.prompt("Rephrased");

			expect(created.getCallCount()).toBe(4);
			expect(events).toEqual([
				"retry-start:1",
				"retry-end:success=false",
				"retry-start:1",
				"retry-end:success=true",
			]);
		});

		describe("threshold compaction", () => {
			// Threshold = contextWindow - reserveTokens = 9,000 tokens. The first turn leaves
			// 8,000 tokens; the refused turn's partial output (~2,000 tokens) tips it over.
			const model: Model<Api> = { ...findModel("anthropic", "sonnet")!, contextWindow: 10_000 };
			const firstTurn: Partial<AssistantMessage> = {
				stopReason: "stop",
				content: [{ type: "text", text: "ok" }],
				usage: {
					input: 8_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 8_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const partialOutput = [{ type: "text" as const, text: "x".repeat(8_000) }];

			function spyOnAutoCompaction(target: AgentSession) {
				return vi
					.spyOn(
						target as unknown as {
							_runAutoCompaction: (
								reason: "overflow" | "threshold",
								willRetry: boolean,
								requestWillFollow: boolean,
							) => Promise<void>;
						},
						"_runAutoCompaction",
					)
					.mockResolvedValue();
			}

			it("does not compact (and auto-continue) after a refusal that crosses the threshold", async () => {
				const created = createSession({
					model,
					compactionReserveTokens: 1_000,
					responses: [
						firstTurn,
						{
							stopReason: "error",
							provider: model.provider,
							model: model.id,
							content: partialOutput,
							errorMessage,
							refusal: { category: "cyber", explanation },
						},
					],
				});
				const runAutoCompaction = spyOnAutoCompaction(created.session);

				await created.session.prompt("First");
				await created.session.prompt("Second");

				expect(runAutoCompaction).not.toHaveBeenCalled();
				expect(created.getCallCount()).toBe(2);
				const last = created.session.messages.at(-1) as AssistantMessage;
				expect(last.refusal).toEqual({ category: "cyber", explanation });

				// The user's next request still compacts first (the pre-prompt check); it is that
				// request, not an automatic continuation, that follows the compaction.
				await created.session.prompt("Third");

				expect(runAutoCompaction).toHaveBeenNthCalledWith(1, "threshold", false, true);
				expect(created.getCallCount()).toBe(3);
			});

			it("still compacts after a non-refusal error that crosses the threshold", async () => {
				const created = createSession({
					model,
					compactionReserveTokens: 1_000,
					responses: [
						firstTurn,
						{
							stopReason: "error",
							provider: model.provider,
							model: model.id,
							content: partialOutput,
							errorMessage: "400 invalid_request_error: malformed tool result",
						},
					],
				});
				const runAutoCompaction = spyOnAutoCompaction(created.session);

				await created.session.prompt("First");
				await created.session.prompt("Second");

				expect(runAutoCompaction).toHaveBeenCalledWith("threshold", false, false);
			});
		});
	});

	it("retries on 'ended without' error", async () => {
		let callCount = 0;
		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "request ended without sending any chunks",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
		expect(session.isRetrying).toBe(false);
	});

	it("forwards stream_retry events to extensions with the discarded partial", async () => {
		let callCount = 0;
		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamRetries: 1,
			streamRetryBaseDelayMs: 1,
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("partial", {
							stopReason: "error",
							errorMessage: "Stream ended without message_delta — connection likely dropped",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
						return;
					}
					const msg = createAssistantMessage("Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const extensionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		const sessionWithRunner = session as unknown as SessionWithExtensionEmitHook;
		sessionWithRunner._extensionRunner = {
			hasExtensions: true,
			hasHandlers: () => false,
			emit: async (event) => {
				extensionEvents.push(event);
			},
			emitBeforeAgentStart: async () => undefined,
		};

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(extensionEvents.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"stream_retry",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const streamRetry = extensionEvents.find((event) => event.type === "stream_retry");
		expect(streamRetry).toMatchObject({
			type: "stream_retry",
			attempt: 1,
			maxAttempts: 1,
			error: "Stream ended without message_delta — connection likely dropped",
			discardedPartial: { content: [{ type: "text", text: "partial" }] },
		});
	});

	it("forwards length_retry events to extensions with correct field mapping and discarded partial", async () => {
		// Positive path: the first call truncates at Sonnet's configured 64000-token
		// limit and the retry uses that same limit. This drives the _handleEvents
		// length_retry branch and verifies its fixed-budget event shape.
		let callCount = 0;
		const model = { ...findModel("anthropic", "sonnet")!, maxTokens: 64000 };
		// Keep the test fixture stable even if the live registry changes Sonnet's ceiling.
		expect(model.maxTokens).toBe(64000);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			lengthRetries: 1,
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = createAssistantMessage("partial", { stopReason: "length" });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "length", message: msg });
						return;
					}
					const msg = createAssistantMessage("Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Disable session-level auto-retry for determinism.
		settingsManager.applyOverrides({ retry: { enabled: false } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const extensionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		const sessionWithRunner = session as unknown as SessionWithExtensionEmitHook;
		sessionWithRunner._extensionRunner = {
			hasExtensions: true,
			hasHandlers: () => false,
			emit: async (event) => {
				extensionEvents.push(event);
			},
			emitBeforeAgentStart: async () => undefined,
		};

		await session.prompt("Test");

		expect(callCount).toBe(2);
		const lengthRetries = extensionEvents.filter((event) => event.type === "length_retry");
		expect(lengthRetries).toHaveLength(1);
		expect(lengthRetries[0]).toMatchObject({
			type: "length_retry",
			attempt: 1,
			maxAttempts: 1,
			maxTokens: 64000,
			discardedPartial: { content: [{ type: "text", text: "partial" }] },
		});

		// The retry succeeded — the turn ends without an error.
		const messageEnd = extensionEvents.findLast((event) => event.type === "message_end") as
			| { message: AssistantMessage }
			| undefined;
		expect(messageEnd).toBeDefined();
		expect((messageEnd?.message as AssistantMessage).stopReason).toBe("stop");
	});

	it("retries length truncation at the model maximum, then fails loudly", async () => {
		// Ordinary Agent calls use the model's configured maximum on every attempt.
		// Two retries are allowed before the third truncation fails loudly.
		let callCount = 0;
		const model = { ...findModel("anthropic", "sonnet")!, maxTokens: 64000 };
		// Keep the test fixture stable even if the live registry changes Sonnet's ceiling.
		expect(model.maxTokens).toBe(64000);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			lengthRetries: 2,
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					// The model truncates at the token limit on every attempt.
					const msg = createAssistantMessage("partial", { stopReason: "length" });
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "length", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Disable session-level auto-retry so the truncation surfaces directly.
		settingsManager.applyOverrides({ retry: { enabled: false } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const extensionEvents: Array<{ type: string; [key: string]: unknown }> = [];
		const sessionWithRunner = session as unknown as SessionWithExtensionEmitHook;
		sessionWithRunner._extensionRunner = {
			hasExtensions: true,
			hasHandlers: () => false,
			emit: async (event) => {
				extensionEvents.push(event);
			},
			emitBeforeAgentStart: async () => undefined,
		};

		await session.prompt("Test");

		// The initial call and both retries use 64000; the third truncation fails.
		expect(callCount).toBe(3);
		const lengthRetries = extensionEvents.filter((event) => event.type === "length_retry");
		expect(lengthRetries).toHaveLength(2);
		expect(lengthRetries[0]).toMatchObject({ maxTokens: 64000 });
		expect(lengthRetries[1]).toMatchObject({ maxTokens: 64000 });

		// The turn fails loudly with a truncation error.
		const messageEnd = extensionEvents.findLast((event) => event.type === "message_end") as
			| { message: AssistantMessage }
			| undefined;
		expect(messageEnd).toBeDefined();
		const assistant = messageEnd?.message as AssistantMessage;
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toMatch(/truncated|token limit/);
	});

	it("exhausts max retries and emits failure", async () => {
		const created = createSession({ failCount: 99, maxRetries: 2 });
		const events: string[] = [];
		created.session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(3);
		expect(events).toContain("start:1");
		expect(events).toContain("start:2");
		expect(events).toContain("end:success=false");
		expect(created.session.isRetrying).toBe(false);
	});

	it("prompt waits for retry completion even when assistant message_end handling is delayed", async () => {
		const created = createSession({ failCount: 1, delayAssistantMessageEndMs: 40 });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.isRetrying).toBe(false);
	});

	it("retries provider network_error failures", async () => {
		const created = createSession({ failCount: 0 });
		let callCount = 0;
		const streamFn = () => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount === 1) {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "Provider finish_reason: network_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
					return;
				}

				const msg = createAssistantMessage("Recovered after retry");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		};
		created.session.dispose();

		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		expect(callCount).toBe(2);
		expect(events).toEqual(["start:1", "end:success=true"]);
	});

	it("prompt waits for full agent loop when retry produces tool calls", async () => {
		// Regression: when auto-retry fires and the retry response includes tool_use,
		// session.prompt() must wait for the entire tool loop to finish before returning.
		// Previously, _resolveRetry() on the first successful message_end would unblock
		// waitForRetry() while the agent was still executing tools.
		let callCount = 0;
		const toolExecuted = { value: false };

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted.value = true;
				return { content: [{ type: "text", text: "echoed" }], details: undefined };
			},
		};

		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						// First call: overloaded error
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else if (callCount === 2) {
						// Second call (retry): text + tool_use
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						// Third call (after tool result): final response
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		await session.prompt("Test");

		// All three LLM calls must have completed
		expect(callCount).toBe(3);
		// Tool must have been executed
		expect(toolExecuted.value).toBe(true);
		// Agent must not be streaming after prompt returns
		expect(session.isStreaming).toBe(false);
		// A follow-up prompt must work (no "Agent is already processing" error)
		await session.prompt("Follow-up");
		expect(callCount).toBe(4);
	});
});
