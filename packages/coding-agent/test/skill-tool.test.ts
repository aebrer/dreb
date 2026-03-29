import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createSkillToolDefinition } from "../src/core/tools/skill.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");

function createTestSkill(
	overrides: Partial<Skill> & { name: string; description: string; filePath: string; baseDir: string },
): Skill {
	return {
		sourceInfo: createSyntheticSourceInfo(overrides.filePath, { source: "test" }),
		disableModelInvocation: false,
		userInvocable: true,
		...overrides,
	};
}

const validSkill = createTestSkill({
	name: "valid-skill",
	description: "A valid skill for testing purposes.",
	filePath: resolve(fixturesDir, "valid-skill/SKILL.md"),
	baseDir: resolve(fixturesDir, "valid-skill"),
});

const disabledSkill = createTestSkill({
	name: "disable-model-invocation",
	description: "A skill that cannot be invoked by the model.",
	filePath: resolve(fixturesDir, "disable-model-invocation/SKILL.md"),
	baseDir: resolve(fixturesDir, "disable-model-invocation"),
	disableModelInvocation: true,
});

const substitutionSkill = createTestSkill({
	name: "substitution-test",
	description: "A skill for testing content substitution.",
	filePath: resolve(fixturesDir, "substitution-test/SKILL.md"),
	baseDir: resolve(fixturesDir, "substitution-test"),
});

const lookaheadSkill = createTestSkill({
	name: "dollar-zero-lookahead",
	description: "Tests that $0 negative lookahead does not match $00 or $01.",
	filePath: resolve(fixturesDir, "dollar-zero-lookahead/SKILL.md"),
	baseDir: resolve(fixturesDir, "dollar-zero-lookahead"),
});

const allSkills = [validSkill, disabledSkill, substitutionSkill, lookaheadSkill];
let sessionId = "test-session-123";

function createTool(skills: Skill[] = allSkills) {
	return createSkillToolDefinition(process.cwd(), {
		getSkills: () => skills,
		getSessionId: () => sessionId,
	});
}

describe("skill tool", () => {
	it("should invoke a valid skill and return expanded content", async () => {
		const tool = createTool();
		const result = await tool.execute("call-1", { skill: "valid-skill" }, undefined, undefined, {} as any);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain('<skill name="valid-skill"');
		expect(text).toContain("This is a valid skill that follows the Agent Skills standard.");
		expect(result.details.found).toBe(true);
		expect(result.details.warned).toBe(false);
	});

	it("should return error with available skills for unknown skill", async () => {
		const tool = createTool();
		const result = await tool.execute("call-2", { skill: "nonexistent" }, undefined, undefined, {} as any);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain('Unknown skill "nonexistent"');
		expect(text).toContain("valid-skill");
		expect(text).toContain("substitution-test");
		expect(result.details.found).toBe(false);
	});

	it("should return warning for skills with disableModelInvocation", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-3",
			{ skill: "disable-model-invocation" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("model invocation disabled");
		expect(text).toContain("ask the user for clarification");
		expect(result.details.found).toBe(true);
		expect(result.details.warned).toBe(true);
	});

	it("should apply content substitution with arguments", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-4",
			{ skill: "substitution-test", args: "foo bar" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		// $0 and $1 should both be "foo"
		expect(text).toContain("Review foo in foo bar.");
		expect(text).toContain("First arg: foo, second arg: bar.");
		expect(text).toContain(`Skill dir: ${resolve(fixturesDir, "substitution-test")}.`);
		expect(text).toContain(`Session: ${sessionId}.`);
	});

	it("should handle empty args gracefully", async () => {
		const tool = createTool();
		const result = await tool.execute("call-5", { skill: "substitution-test" }, undefined, undefined, {} as any);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		// $0 and $1 should be empty, $ARGUMENTS should be empty
		expect(text).toContain("Review  in .");
		expect(text).toContain("First arg: , second arg: .");
		// Should not have raw args appended after </skill>
		expect(text).toMatch(/<\/skill>$/);
	});

	it("should append raw args after skill block when args provided", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-6",
			{ skill: "valid-skill", args: "my arguments" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("</skill>");
		// Raw args are no longer appended — content substitution handles arg embedding
		expect(text).not.toContain("my arguments");
	});

	it("should return error with empty list when no skills loaded", async () => {
		const tool = createTool([]);
		const result = await tool.execute("call-7", { skill: "anything" }, undefined, undefined, {} as any);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain('Unknown skill "anything"');
		expect(text).toContain("(none loaded)");
	});

	it("should exclude disableModelInvocation skills from unknown skill error list", async () => {
		const tool = createTool();
		const result = await tool.execute("call-9", { skill: "nonexistent" }, undefined, undefined, {} as any);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("valid-skill");
		expect(text).toContain("substitution-test");
		expect(text).not.toContain("disable-model-invocation");
	});

	it("should reflect getSessionId() at invocation time", async () => {
		const tool = createTool();

		const result1 = await tool.execute("call-10a", { skill: "substitution-test" }, undefined, undefined, {} as any);
		const text1 = (result1.content[0] as { type: "text"; text: string }).text;
		expect(text1).toContain("Session: test-session-123.");

		// Simulate session rotation
		sessionId = "rotated-session-456";
		const result2 = await tool.execute("call-10b", { skill: "substitution-test" }, undefined, undefined, {} as any);
		const text2 = (result2.content[0] as { type: "text"; text: string }).text;
		expect(text2).toContain("Session: rotated-session-456.");

		// Reset for other tests
		sessionId = "test-session-123";
	});

	it("should return error when skill file cannot be read", async () => {
		const brokenSkill = createTestSkill({
			name: "broken-skill",
			description: "A skill with a nonexistent file.",
			filePath: resolve(fixturesDir, "nonexistent/SKILL.md"),
			baseDir: resolve(fixturesDir, "nonexistent"),
		});
		const tool = createTool([brokenSkill]);
		const result = await tool.execute("call-err", { skill: "broken-skill" }, undefined, undefined, {} as any);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain('Error loading skill "broken-skill"');
		expect(text).toContain("ENOENT");
		expect(result.details.found).toBe(true);
		expect(result.details.warned).toBe(false);
	});

	it("should not substitute $0 inside $00 or $01 (negative lookahead)", async () => {
		const tool = createTool();
		const result = await tool.execute(
			"call-lookahead",
			{ skill: "dollar-zero-lookahead", args: "FIRST" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as { type: "text"; text: string }).text;
		// $0 should be replaced with "FIRST"
		expect(text).toContain("Zero: FIRST.");
		// $00 should NOT be touched by $0 replacement — it's not a valid variable
		// substituteArgs skips $0 (matches $1+ only), so $00 passes through as literal "$00"
		expect(text).toContain("Double-zero: $00.");
		// $01 should NOT be touched by $0 replacement
		expect(text).toContain("Zero-one: $01.");
		// $10 is handled by substituteArgs as positional arg 10 (empty here)
		expect(text).toContain("Ten: .");
	});

	it("should reflect getSkills() at invocation time", async () => {
		const mutableSkills: Skill[] = [];
		const tool = createSkillToolDefinition(process.cwd(), {
			getSkills: () => mutableSkills,
			getSessionId: () => sessionId,
		});

		// Initially no skills
		const result1 = await tool.execute("call-8a", { skill: "valid-skill" }, undefined, undefined, {} as any);
		expect(result1.details.found).toBe(false);

		// Add skill dynamically
		mutableSkills.push(validSkill);
		const result2 = await tool.execute("call-8b", { skill: "valid-skill" }, undefined, undefined, {} as any);
		expect(result2.details.found).toBe(true);
	});
});
