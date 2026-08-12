import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.js";

/**
 * Tests for package-bundled agent definitions (shipped in agents/).
 * Validates that agent .md files have correct frontmatter and will
 * be discovered by discoverAgentTypes at runtime.
 */

function parseAgentFrontmatter(
	content: string,
): { name?: string; description?: string; tools?: string; model?: string; body: string } | null {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!fmMatch) return null;

	const frontmatter = fmMatch[1];
	const body = fmMatch[2].trim();

	const get = (key: string): string | undefined => {
		const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return match?.[1].trim();
	};

	return {
		name: get("name"),
		description: get("description"),
		tools: get("tools"),
		model: get("model"),
		body,
	};
}

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
			const file = agentFiles.find((f) => f === `${expectedName}.md`);
			expect(file, `${expectedName}.md not found in ${agentsDir}`).toBeDefined();

			const content = readFileSync(join(agentsDir, file!), "utf-8");
			const parsed = parseAgentFrontmatter(content);
			expect(parsed, `${expectedName}.md has invalid frontmatter`).not.toBeNull();
			expect(parsed!.name).toBe(expectedName);
			expect(parsed!.description).toBeTruthy();
			expect(parsed!.body.length).toBeGreaterThan(0);
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
		expect(devil).toContain("Never post to GitHub");
	});

	it("all agent files should have valid frontmatter with required fields", () => {
		const agentFiles = getAgentFiles();
		expect(agentFiles.length).toBeGreaterThan(0);
		for (const file of agentFiles) {
			const content = readFileSync(join(agentsDir, file), "utf-8");
			const parsed = parseAgentFrontmatter(content);
			expect(parsed, `${file} missing --- frontmatter delimiters`).not.toBeNull();
			expect(parsed!.name, `${file} missing name`).toBeTruthy();
		}
	});
});
