/**
 * Tests for AgentSession.warnStaleAgentModelKeys() — the LOUD stale-key warning
 * for agentModels settings that reference agents which no longer exist (typo or
 * renamed/removed upstream agent). Without this, such overrides are silently
 * ignored at resolution time.
 *
 * Covers PR 220 review finding 6.
 */

import { Agent } from "@dreb/agent-core";
import { findModel } from "@dreb/ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { discoverAgentTypes } from "../src/core/tools/index.js";
import { createTestResourceLoader } from "./utilities.js";

const model = findModel("anthropic", "sonnet")!;

function createSessionWithSettings(settingsManager: SettingsManager) {
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test.",
			tools: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader(),
	});

	session.subscribe(() => {});

	return session;
}

describe("warnStaleAgentModelKeys", () => {
	it("warns when a configured agent key does not match any discovered agent", () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setAgentModelsForAgent("NoSuchAgent", ["anthropic/sonnet"]);

		const session = createSessionWithSettings(settingsManager);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnStaleAgentModelKeys();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("agentModels settings reference unknown agent(s): NoSuchAgent");
			expect(message).toContain("These overrides will be ignored");
			expect(message).toContain("renamed/removed agents");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("does not warn for a valid discovered agent key (case-sensitive match)", () => {
		// "Explore" is a package-bundled agent — discoverAgentTypes keys it with
		// exactly this casing, which is the same lookup getAgentModelsForAgent uses.
		const discovered = discoverAgentTypes(process.cwd());
		expect(discovered.has("Explore")).toBe(true);

		const settingsManager = SettingsManager.inMemory();
		settingsManager.setAgentModelsForAgent("Explore", ["anthropic/sonnet"]);

		const session = createSessionWithSettings(settingsManager);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnStaleAgentModelKeys();

			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("flags a key with wrong casing as stale (case-sensitive)", () => {
		// "explore" (lowercase) is NOT how discoverAgentTypes keys the agent, so
		// it would be silently ignored at resolution and must be flagged.
		const discovered = discoverAgentTypes(process.cwd());
		expect(discovered.has("explore")).toBe(false);

		const settingsManager = SettingsManager.inMemory();
		settingsManager.setAgentModelsForAgent("explore", ["anthropic/sonnet"]);

		const session = createSessionWithSettings(settingsManager);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnStaleAgentModelKeys();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toContain("unknown agent(s): explore");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("lists multiple stale keys together", () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setAgentModelsForAgent("OldName", ["anthropic/sonnet"]);
		settingsManager.setAgentModelsForAgent("AnotherGone", ["anthropic/sonnet"]);

		const session = createSessionWithSettings(settingsManager);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnStaleAgentModelKeys();

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0][0];
			expect(message).toContain("OldName");
			expect(message).toContain("AnotherGone");

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("does not warn when no agentModels are configured", () => {
		const settingsManager = SettingsManager.inMemory();

		const session = createSessionWithSettings(settingsManager);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession");

			session.warnStaleAgentModelKeys();

			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});
});
