import { findModel } from "@dreb/ai";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// Adaptive-thinking model (Opus/Sonnet 4.6+): thinkingDisplay is honored, defaults to "summarized".
const adaptiveModel = findModel("anthropic", "opus-4-8")!;
// Reasoning model that is NOT adaptive: thinkingDisplay resolves to undefined.
const nonAdaptiveModel = findModel("anthropic", "sonnet-4-5")!;

async function createSession(model: typeof adaptiveModel, settingsManager: SettingsManager) {
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		model,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

describe("createAgentSession thinkingDisplay seeding", () => {
	it("seeds 'summarized' for an adaptive model with no stored override", async () => {
		const session = await createSession(adaptiveModel, SettingsManager.inMemory());
		try {
			expect(session.agent.thinkingDisplay).toBe("summarized");
		} finally {
			session.dispose();
		}
	});

	it("seeds the stored 'omitted' override for an adaptive model", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setModelThinkingDisplay(adaptiveModel.id, "omitted");
		const session = await createSession(adaptiveModel, settingsManager);
		try {
			expect(session.agent.thinkingDisplay).toBe("omitted");
		} finally {
			session.dispose();
		}
	});

	it("leaves thinkingDisplay undefined for a non-adaptive model", async () => {
		const session = await createSession(nonAdaptiveModel, SettingsManager.inMemory());
		try {
			expect(session.agent.thinkingDisplay).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("ignores a stored override for a non-adaptive model (still undefined)", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setModelThinkingDisplay(nonAdaptiveModel.id, "omitted");
		const session = await createSession(nonAdaptiveModel, settingsManager);
		try {
			expect(session.agent.thinkingDisplay).toBeUndefined();
		} finally {
			session.dispose();
		}
	});
});
