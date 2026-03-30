import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
	return {
		name: "test-skill",
		description: "A test skill for unit testing",
		filePath: "/tmp/skills/test-skill/SKILL.md",
		baseDir: "/tmp/skills/test-skill",
		sourceInfo: createSyntheticSourceInfo("/tmp/skills/test-skill/SKILL.md", { source: "test" }),
		disableModelInvocation: false,
		userInvocable: true,
		...overrides,
	};
}

describe("buildSystemPrompt skill-gating", () => {
	const skills = [makeSkill()];

	describe("default prompt (no customPrompt)", () => {
		test("includes skills when selectedTools contains 'read'", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("includes skills when selectedTools contains 'skill'", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["skill"],
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("includes skills when selectedTools contains both 'read' and 'skill'", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "skill", "bash"],
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("suppresses skills when selectedTools contains neither 'read' nor 'skill'", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "edit", "write"],
				contextFiles: [],
				skills,
			});

			expect(prompt).not.toContain("available_skills");
			expect(prompt).not.toContain("test-skill");
		});

		test("suppresses skills when selectedTools is empty", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills,
			});

			expect(prompt).not.toContain("available_skills");
			expect(prompt).not.toContain("test-skill");
		});
	});

	describe("custom prompt", () => {
		const customPrompt = "You are a custom assistant.";

		test("includes skills when selectedTools is undefined (no restriction)", () => {
			const prompt = buildSystemPrompt({
				customPrompt,
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("includes skills when selectedTools contains 'read'", () => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["read"],
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("includes skills when selectedTools contains 'skill'", () => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["skill"],
				contextFiles: [],
				skills,
			});

			expect(prompt).toContain("available_skills");
			expect(prompt).toContain("test-skill");
		});

		test("suppresses skills when selectedTools contains neither 'read' nor 'skill'", () => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills,
			});

			expect(prompt).not.toContain("available_skills");
			expect(prompt).not.toContain("test-skill");
		});
	});

	describe("disableModelInvocation interaction", () => {
		test("skills with disableModelInvocation are excluded even when gating allows", () => {
			const hiddenSkill = makeSkill({
				name: "hidden-skill",
				disableModelInvocation: true,
			});

			const prompt = buildSystemPrompt({
				selectedTools: ["read", "skill"],
				contextFiles: [],
				skills: [hiddenSkill],
			});

			// The skills section should not appear since the only skill is hidden
			expect(prompt).not.toContain("hidden-skill");
		});

		test("visible skills appear alongside hidden ones", () => {
			const hiddenSkill = makeSkill({
				name: "hidden-skill",
				disableModelInvocation: true,
			});
			const visibleSkill = makeSkill({ name: "visible-skill" });

			const prompt = buildSystemPrompt({
				selectedTools: ["read", "skill"],
				contextFiles: [],
				skills: [hiddenSkill, visibleSkill],
			});

			expect(prompt).toContain("visible-skill");
			expect(prompt).not.toContain("hidden-skill");
		});
	});
});
