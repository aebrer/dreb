import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, findModel } from "@dreb/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	K3_1M_CONTEXT_WINDOW,
	K3_256K_CONTEXT_WINDOW,
	K3_256K_WIRE_MODEL_ID,
	K3_UPGRADE_CUTOFF_TOKENS,
} from "../src/core/k3-context-tier.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function bigAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "..." }],
		api: "openai-completions",
		provider: "kimi-coding-oauth",
		model: "k3",
		usage: {
			input: 240000,
			output: 7000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: K3_UPGRADE_CUTOFF_TOKENS + 5000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("createAgentSession K3 auto context tier", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `dreb-k3-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(sessionManager: SessionManager) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("kimi-coding-oauth", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: findModel("kimi-coding-oauth", "k3")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});
		return session;
	}

	it("starts a fresh k3 session on the cheaper 256k wire tier", async () => {
		const session = await createSession(SessionManager.inMemory());

		expect(session.model?.id).toBe("k3");
		expect(session.model?.wireModelId).toBe(K3_256K_WIRE_MODEL_ID);
		expect(session.model?.contextWindow).toBe(K3_256K_CONTEXT_WINDOW);

		session.dispose();
	});

	it("resumes straight into the 1M tier when restored context already exceeds the cutoff", async () => {
		const sessionManager = SessionManager.create(tempDir);
		sessionManager.appendModelChange("kimi-coding-oauth", "k3");
		sessionManager.appendMessage(bigAssistantMessage());

		const session = await createSession(sessionManager);

		expect(session.model?.id).toBe("k3");
		expect(session.model?.wireModelId).toBeUndefined();
		expect(session.model?.contextWindow).toBe(K3_1M_CONTEXT_WINDOW);

		session.dispose();
	});
});
