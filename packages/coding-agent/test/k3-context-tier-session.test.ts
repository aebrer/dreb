import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dreb/agent-core";
import { type AssistantMessage, findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	K3_1M_CONTEXT_WINDOW,
	K3_256K_CONTEXT_WINDOW,
	K3_256K_WIRE_MODEL_ID,
	K3_UPGRADE_CUTOFF_TOKENS,
} from "../src/core/k3-context-tier.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({
		summary: "compacted",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		details: {},
	}),
	estimateContextTokens: (
		messages: Array<{
			role: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		// Walk backwards to find last non-error, non-aborted assistant with usage
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const tokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				return { tokens, usageTokens: tokens, trailingTokens: 0, lastUsageIndex: i };
			}
		}
		return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		model: "k3",
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

describe("AgentSession K3 auto context tier", () => {
	let session: AgentSession;
	let tempDir: string;
	let settingsManager: SettingsManager;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-k3-tier-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];

		const model = findModel("anthropic", "sonnet")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		const sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("kimi-coding-oauth", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		session.subscribe((event) => {
			events.push(event);
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function selectK3() {
		const k3 = findModel("kimi-coding-oauth", "k3")!;
		await session.setModel(k3);
	}

	async function checkCompaction(message: AssistantMessage) {
		await (
			session as unknown as {
				_checkCompaction: (msg: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction(message);
	}

	it("starts the user-facing k3 model in the cheaper 256k wire tier", async () => {
		await selectK3();

		expect(session.model?.id).toBe("k3");
		expect(session.model?.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
		expect(session.model?.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);
	});

	it("leaves non-K3 models untouched", async () => {
		expect(session.model?.id).toContain("claude");
		expect(session.model?.wireModelId).toBeUndefined();
	});

	it("upgrades to the 1M tier instead of compacting at the default threshold", async () => {
		await selectK3();

		await checkCompaction(
			assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: K3_UPGRADE_CUTOFF_TOKENS + 1 } }),
		);

		expect(session.model?.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);
		expect(session.model?.wireModelId).toBeUndefined();
		expect(events.some((e) => e.type === "context_window_upgrade")).toBe(true);
		expect(events.some((e) => e.type === "auto_compaction_start")).toBe(false);
	});

	it("stays in the 256k tier below the cutoff", async () => {
		await selectK3();

		await checkCompaction(
			assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: K3_UPGRADE_CUTOFF_TOKENS - 1000 } }),
		);

		expect(session.model?.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);
		expect(session.model?.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
		expect(events.some((e) => e.type === "context_window_upgrade")).toBe(false);
		expect(events.some((e) => e.type === "auto_compaction_start")).toBe(false);
	});

	it("compacts first when the user lowers the compaction threshold, effectively disabling the upgrade", async () => {
		await selectK3();
		// Apply after setModel: setModel persists the default model, which
		// rebuilds settings from the on-disk layers.
		settingsManager.applyOverrides({ compaction: { reserveTokens: 100000 } });

		// 200k tokens: below the 256k upgrade cutoff (245760) but past the
		// user-lowered compaction threshold (262144 - 100000 = 162144).
		await checkCompaction(assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: 200000 } }));

		expect(events.some((e) => e.type === "auto_compaction_start")).toBe(true);
		expect(events.some((e) => e.type === "context_window_upgrade")).toBe(false);
		expect(session.model?.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);
	});

	it("upgrades instead of compacting when the 256k tier overflows", async () => {
		vi.useFakeTimers();
		await selectK3();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		await checkCompaction(
			assistantMessage({
				stopReason: "error",
				errorMessage: "exceeded model token limit: 262144 (requested: 300000)",
			}),
		);
		await vi.advanceTimersByTimeAsync(100);

		expect(session.model?.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);
		expect(session.model?.wireModelId).toBeUndefined();
		expect(events.some((e) => e.type === "context_window_upgrade")).toBe(true);
		expect(events.some((e) => e.type === "auto_compaction_start")).toBe(false);
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("still upgrades on overflow when compaction is disabled", async () => {
		vi.useFakeTimers();
		await selectK3();
		// Apply after setModel: setModel persists the default model, which
		// rebuilds settings from the on-disk layers.
		settingsManager.applyOverrides({ compaction: { enabled: false } });
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		await checkCompaction(
			assistantMessage({
				stopReason: "error",
				errorMessage: "exceeded model token limit: 262144 (requested: 300000)",
			}),
		);
		await vi.advanceTimersByTimeAsync(100);

		expect(session.model?.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);
		expect(events.some((e) => e.type === "context_window_upgrade")).toBe(true);
	});

	it("does not upgrade on overflow once already in the 1M tier", async () => {
		vi.useFakeTimers();
		await selectK3();
		// Pre-seed a large context so setModel derives the 1M tier directly.
		session.agent.replaceMessages([
			assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: K3_UPGRADE_CUTOFF_TOKENS + 5000 } }),
		]);
		await selectK3();
		expect(session.model?.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);

		const upgradeEventsBefore = events.filter((e) => e.type === "context_window_upgrade").length;
		await checkCompaction(
			assistantMessage({
				stopReason: "error",
				errorMessage: "exceeded model token limit: 1048576 (requested: 1100000)",
			}),
		);
		await vi.advanceTimersByTimeAsync(100);

		// 1M-tier overflow falls back to the normal compaction recovery path.
		expect(events.filter((e) => e.type === "context_window_upgrade")).toHaveLength(upgradeEventsBefore);
		expect(events.some((e) => e.type === "auto_compaction_start")).toBe(true);
	});
});
