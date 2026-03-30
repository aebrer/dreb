/**
 * Integration tests for AgentSession._expandSkillCommand
 *
 * Tests the private _expandSkillCommand method which is called from
 * prompt(), steer(), and followUp() to expand /skill:name commands.
 *
 * Covers: issue 45
 */

import { Agent } from "@dreb/agent-core";
import { getModel } from "@dreb/ai";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createTestResourceLoader } from "./utilities.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const model = getModel("anthropic", "claude-sonnet-4-5")!;

function makeSkill(overrides: Partial<Skill> & { name: string; filePath: string; baseDir: string }): Skill {
	return {
		description: "Test skill",
		sourceInfo: createSyntheticSourceInfo(overrides.filePath, { source: "test" }),
		disableModelInvocation: false,
		userInvocable: true,
		...overrides,
	};
}

const validSkill = makeSkill({
	name: "valid-skill",
	description: "A valid skill for testing.",
	filePath: resolve(fixturesDir, "valid-skill/SKILL.md"),
	baseDir: resolve(fixturesDir, "valid-skill"),
});

const substitutionSkill = makeSkill({
	name: "substitution-test",
	description: "A skill for testing content substitution.",
	filePath: resolve(fixturesDir, "substitution-test/SKILL.md"),
	baseDir: resolve(fixturesDir, "substitution-test"),
});

const brokenSkill = makeSkill({
	name: "broken-skill",
	description: "A skill pointing to a nonexistent file.",
	filePath: resolve(fixturesDir, "nonexistent/SKILL.md"),
	baseDir: resolve(fixturesDir, "nonexistent"),
});

function createSession(skills: Skill[]) {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader({ skills }),
	});

	// Required for session to function
	session.subscribe(() => {});

	return session;
}

// Access the private method for testing
function expandSkillCommand(session: AgentSession, text: string): string {
	return (session as any)._expandSkillCommand(text);
}

describe("AgentSession._expandSkillCommand", () => {
	it("passes non-skill input through unchanged", () => {
		const session = createSession([validSkill]);
		try {
			expect(expandSkillCommand(session, "hello world")).toBe("hello world");
			expect(expandSkillCommand(session, "/help")).toBe("/help");
			expect(expandSkillCommand(session, "/model sonnet")).toBe("/model sonnet");
			expect(expandSkillCommand(session, "")).toBe("");
		} finally {
			session.dispose();
		}
	});

	it("expands /skill:name with no args", () => {
		const session = createSession([validSkill]);
		try {
			const result = expandSkillCommand(session, "/skill:valid-skill");
			expect(result).toContain('<skill name="valid-skill"');
			expect(result).toContain("This is a valid skill that follows the Agent Skills standard.");
		} finally {
			session.dispose();
		}
	});

	it("expands /skill:name with args and performs substitution", () => {
		const session = createSession([substitutionSkill]);
		try {
			const result = expandSkillCommand(session, "/skill:substitution-test foo bar");
			expect(result).toContain('<skill name="substitution-test"');
			expect(result).toContain("Review foo in foo bar.");
			expect(result).toContain("First arg: foo, second arg: bar.");
			expect(result).toContain(`Skill dir: ${resolve(fixturesDir, "substitution-test")}.`);
		} finally {
			session.dispose();
		}
	});

	it("returns original text for unknown skill name", () => {
		const session = createSession([validSkill]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:nonexistent");
			expect(result).toBe("/skill:nonexistent");
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown skill "nonexistent"'));
			consoleSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("returns original text for unknown skill with args", () => {
		const session = createSession([validSkill]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:nonexistent some args");
			expect(result).toBe("/skill:nonexistent some args");
			consoleSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("returns original text when skill file cannot be read (error path)", () => {
		const session = createSession([brokenSkill]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:broken-skill");
			expect(result).toBe("/skill:broken-skill");
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Skill expansion error"));
			consoleSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("returns original text when no skills are loaded", () => {
		const session = createSession([]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:anything");
			expect(result).toBe("/skill:anything");
			consoleSpy.mockRestore();
		} finally {
			session.dispose();
		}
	});

	it("handles skill name with no trailing text correctly", () => {
		const session = createSession([validSkill]);
		try {
			// No space means entire text after /skill: is the skill name
			const result = expandSkillCommand(session, "/skill:valid-skill");
			expect(result).toContain('<skill name="valid-skill"');
		} finally {
			session.dispose();
		}
	});
});
