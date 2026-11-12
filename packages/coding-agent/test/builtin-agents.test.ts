import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.js";
import { parseAgentFrontmatter } from "../src/core/tools/subagent.js";

/**
 * Tests for package-bundled agent definitions (shipped in agents/).
 * Validates that agent .md files have correct frontmatter and will
 * be discovered by discoverAgentTypes at runtime.
 */

function getAgentFiles(): string[] {
	const agentsDir = join(getPackageDir(), "agents");
	if (!existsSync(agentsDir)) return [];
	return readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
}

describe("built-in agent definitions", () => {
	const agentsDir = join(getPackageDir(), "agents");

	it("should have agent definition files in package agents directory", () => {
		const agentFiles = getAgentFiles();
		expect(agentFiles.length).toBeGreaterThan(0);
	});

	const expectedAgents = [
		"Explore",
		"Sandbox",
		"feature-dev",
		"code-reviewer",
		"error-auditor",
		"test-reviewer",
		"completeness-checker",
		"simplifier",
		"independent-assessor",
		"developers-advocate",
		"devils-advocate",
	];

	for (const expectedName of expectedAgents) {
		it(`should include ${expectedName} agent with valid frontmatter`, () => {
			const agentFiles = getAgentFiles();
			const file = agentFiles.find((f) => f === `${expectedName.toLowerCase()}.md`);
			expect(file, `${expectedName}.md not found in ${agentsDir}`).toBeDefined();

			const content = readFileSync(join(agentsDir, file!), "utf-8");
			const parsed = parseAgentFrontmatter(content);
			expect(parsed.ok, `${expectedName}.md has invalid frontmatter`).toBe(true);
			if (!parsed.ok) return;
			expect(parsed.config.name).toBe(expectedName);
			expect(parsed.config.description).toBeTruthy();
			expect(parsed.config.systemPrompt.length).toBeGreaterThan(0);
		});
	}

	it("review counter-pressure agents should encode their required contracts", () => {
		const assessor = readFileSync(join(agentsDir, "independent-assessor.md"), "utf-8");
		expect(assessor).toContain("Factual gate");
		expect(assessor).toContain("Scope gate");
		expect(assessor).toContain("Practical gate");
		expect(assessor).toContain("actor or system component affected");
		expect(assessor).toContain("exact triggering event sequence");
		expect(assessor).toContain("existing safeguards");
		expect(assessor).toContain("material benefit");
		expect(assessor).toContain("**Merge blocker**");
		expect(assessor).toContain("Missing tests are not findings by themselves");

		const developer = readFileSync(join(agentsDir, "developers-advocate.md"), "utf-8");
		expect(developer).toContain("laziness as engineering discipline");
		for (const verdict of ["blocks shipping", "useful follow-up", "review theater", "factually wrong"])
			expect(developer).toContain(verdict);
		expect(developer).toContain("Never generate new findings");
		expect(developer).toContain("Never dismiss automated or red-team attackers");
		expect(developer).toContain("Never post to GitHub");

		const devil = readFileSync(join(agentsDir, "devils-advocate.md"), "utf-8");
		expect(devil).toContain("supplement the broad `test-reviewer`; you do not replace it");
		expect(devil).toContain("acceptance criteria are NOT being met");
		expect(devil).toContain("user's original quoted requests");
		expect(devil).toContain("acceptance criterion has no meaningful proof");
		expect(devil).toContain("originally reported failure is not reproduced");
		expect(devil).toContain("fix could regress while current tests still pass");
		for (const rejected of [
			"branch-coverage",
			"code is new",
			"language or framework semantics",
			"credible producer",
			"duplicate tests",
		])
			expect(devil).toContain(rejected);
		expect(devil).toContain("Design and propose adversarial tests to the parent orchestrator only");
		expect(devil).toContain("do not implement or execute them");
		expect(devil).toContain("Treat the repository and worktree as strictly read-only");
		expect(devil).toContain("Never edit, create, delete, rename, restore");
		expect(devil).toContain("Do not run commands that can modify the worktree or repository state");
		expect(devil).toContain("Never post to GitHub");
	});

	it("all bundled agents have valid frontmatter and no model defaults", () => {
		const agentFiles = getAgentFiles();
		expect(agentFiles.length).toBeGreaterThan(0);
		for (const file of agentFiles) {
			const content = readFileSync(join(agentsDir, file), "utf-8");
			const parsed = parseAgentFrontmatter(content);
			expect(parsed.ok, `${file} has invalid frontmatter`).toBe(true);
			if (!parsed.ok) continue;
			expect(parsed.config.name, `${file} missing name`).toBeTruthy();
			expect(parsed.config.model, `${file} must inherit the parent model by default`).toBeUndefined();
		}
	});
});
