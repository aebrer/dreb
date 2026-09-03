import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dreb/agent-core";
import type { AssistantMessage } from "@dreb/ai";
import { findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { assistantMsg, createTestResourceLoader, userMsg } from "./utilities.js";

/**
 * Non-live regression tests for the final AgentSession → LLM session-ID wiring.
 *
 * The earlier session-ID coverage in this PR was helper-level: tests passed an
 * explicit sessionId into generateBranchSummary()/compact()/hatch() with
 * @dreb/ai mocked, so deleting `this.sessionId` from an AgentSession call site
 * (manual/auto compaction, branch summarization) would keep the entire suite
 * green while stripping the x-opencode-session header from real OpenCode
 * requests. These tests construct a real AgentSession (in-memory harness),
 * mock only the LLM boundary (completeSimple), and assert that
 * session.sessionId reaches every LLM call the auxiliary flows make. Driving
 * the real compact() also covers all of its sessionId fan-out sites at once,
 * including the turn-prefix summary path.
 */

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@dreb/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dreb/ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Mock summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

interface LlmCall {
	model: unknown;
	prompt: { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
	options: Record<string, unknown>;
}

function llmCalls(): LlmCall[] {
	return completeSimpleMock.mock.calls.map(([model, prompt, options]) => ({ model, prompt, options }));
}

function promptText(call: LlmCall): string {
	return call.prompt.messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => block.text ?? "").join(""),
		)
		.join("\n");
}

/**
 * The stable ID the in-memory session was created with. Asserting the UUID
 * shape guards against an empty/undefined session ID silently satisfying
 * equality assertions.
 */
function sessionIdOf(session: AgentSession): string {
	const id = session.sessionId;
	expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	return id;
}

describe("AgentSession session ID wiring (non-live, LLM boundary mocked)", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-session-id-wiring-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);

		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		// Force a deep cut point so compaction exercises both summary paths
		// (normal history summary and split-turn summary) deterministically.
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("forwards the session ID to the summary LLM call on manual compaction", async () => {
		sessionManager.appendMessage(userMsg("first question"));
		sessionManager.appendMessage(assistantMsg("first answer"));
		sessionManager.appendMessage(userMsg("second question"));

		await session.compact();

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [call] = llmCalls();
		expect(call.model).toBe(session.model);
		expect(call.options).toMatchObject({ apiKey: "test-key", sessionId: sessionIdOf(session) });
		// Normal (non-split) path: history summary prompt, no turn-prefix prompt
		expect(promptText(call)).toContain("a conversation to summarize");
		expect(promptText(call)).not.toContain("PREFIX of a turn that was too large to keep");
	});

	it("forwards the session ID to both LLM calls when a manual compaction splits a turn", async () => {
		// u1 → a1 | u2 → a2 → a3: with keepRecentTokens=1 the cut lands on the
		// final assistant (mid-turn), so compact() fans out to BOTH the history
		// generateSummary and the turn-prefix generateTurnPrefixSummary.
		sessionManager.appendMessage(userMsg("first question"));
		sessionManager.appendMessage(assistantMsg("first answer"));
		sessionManager.appendMessage(userMsg("second question"));
		sessionManager.appendMessage(assistantMsg("second answer"));
		sessionManager.appendMessage(assistantMsg("third answer"));

		await session.compact();

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const calls = llmCalls();
		for (const call of calls) {
			expect(call.model).toBe(session.model);
			expect(call.options).toMatchObject({ apiKey: "test-key", sessionId: sessionIdOf(session) });
		}
		const texts = calls.map(promptText);
		expect(texts.filter((text) => text.includes("a conversation to summarize"))).toHaveLength(1);
		expect(texts.filter((text) => text.includes("PREFIX of a turn that was too large to keep"))).toHaveLength(1);
	});

	it("forwards the session ID to the summary LLM call on auto compaction", async () => {
		sessionManager.appendMessage(userMsg("first question"));
		sessionManager.appendMessage(assistantMsg("first answer"));
		sessionManager.appendMessage(userMsg("second question"));

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [call] = llmCalls();
		expect(call.model).toBe(session.model);
		expect(call.options).toMatchObject({ apiKey: "test-key", sessionId: sessionIdOf(session) });
		expect(promptText(call)).toContain("a conversation to summarize");
	});

	it("forwards the session ID to the branch summary LLM call on tree navigation", async () => {
		const firstUser = sessionManager.appendMessage(userMsg("original question"));
		sessionManager.appendMessage(assistantMsg("original answer"));

		const result = await session.navigateTree(firstUser, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [call] = llmCalls();
		expect(call.model).toBe(session.model);
		expect(call.options).toMatchObject({
			apiKey: "test-key",
			maxTokens: 2048,
			sessionId: sessionIdOf(session),
		});
		expect(promptText(call)).toContain("summary of this conversation branch");
	});
});
