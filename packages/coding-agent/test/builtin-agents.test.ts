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

	it("independent-assessor should enforce factual and authorized-scope gates", () => {
		const content = readFileSync(join(agentsDir, "independent-assessor.md"), "utf-8");
		const parsed = parseAgentFrontmatter(content);
		expect(parsed).not.toBeNull();
		const body = parsed!.body;

		expect(body).toContain("Factual gate");
		expect(body).toContain("Scope gate");
		expect(body).toContain("not genuine merely because it is technically correct or factually observable");
		expect(body).toContain("linked original issue");
		expect(body).toContain("latest explicit plan comment");
		expect(body).toContain("subsequent scope updates that a human explicitly approved");
		expect(body).toContain("prior automated assessments are evidence only");
		expect(body).toContain("do **not** expand scope through novelty, repetition, or earlier classification");
		expect(body).toContain("introduced by the PR");
		expect(body).toContain("both the **Factual** and **Scope** explanations are mandatory");
		expect(body).toContain("Do not include deferred, nitpick, or false-positive findings");
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
