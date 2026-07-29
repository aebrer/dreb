import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");
const packageDir = resolve(__dirname, "..");
const graphifySkillPath = join(packageDir, "skills", "graphify-structural", "SKILL.md");
const graphifySkillDir = dirname(graphifySkillPath);

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	userInvocable?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
		userInvocable: options.userInvocable ?? true,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name doesn't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(true);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field,
			// nested/child-skill, consecutive-hyphens, disable-model-invocation,
			// full-frontmatter, not-user-invocable, substitution-test,
			// root-skill-preferred, multiline-description
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			// NOT: invalid-yaml (parse failure)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});

		it("should parse all frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "full-frontmatter"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			const skill = skills[0];
			expect(skill.name).toBe("full-frontmatter");
			expect(skill.argumentHint).toBe("[PR number or URL]");
			expect(skill.disableModelInvocation).toBe(false);
			expect(skill.userInvocable).toBe(true);
			expect(diagnostics).toHaveLength(0);
		});

		it("should default userInvocable to true when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].userInvocable).toBe(true);
		});

		it("should parse user-invocable: false", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "not-user-invocable"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].userInvocable).toBe(false);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).not.toContain("<location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the skill tool to invoke a skill");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
			});
			// Built-in skills (e.g. mach6) are always loaded, plus the explicit path skill
			const nonBuiltinSkills = skills.filter((s) => s.sourceInfo.source !== "builtin");
			expect(nonBuiltinSkills).toHaveLength(1);
			expect(nonBuiltinSkills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
			});
			// Built-in skills still load even when explicit path doesn't exist
			const nonBuiltinSkills = skills.filter((s) => s.sourceInfo.source !== "builtin");
			expect(nonBuiltinSkills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".dreb/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.dreb/agent/skills"],
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("built-in skills", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load built-in skills with source='builtin' and scope='user'", () => {
			const { skills } = loadSkills({ agentDir: emptyAgentDir, cwd: emptyCwd });
			const builtins = skills.filter((s) => s.sourceInfo.source === "builtin");
			expect(builtins.length).toBeGreaterThan(0);
			for (const s of builtins) {
				expect(s.sourceInfo.scope).toBe("user");
			}
		});

		it("should include all mach6 skills as built-ins", () => {
			const { skills } = loadSkills({ agentDir: emptyAgentDir, cwd: emptyCwd });
			const builtins = skills.filter((s) => s.sourceInfo.source === "builtin");
			const builtinNames = builtins.map((s) => s.name).sort();
			expect(builtinNames).toContain("mach6-issue");
			expect(builtinNames).toContain("mach6-plan");
			expect(builtinNames).toContain("mach6-push");
			expect(builtinNames).toContain("mach6-review");
			expect(builtinNames).toContain("mach6-implement");
			expect(builtinNames).toContain("mach6-publish");
		});

		it("should discover graphify-structural as a built-in with its source metadata", () => {
			const { skills } = loadSkills({ agentDir: emptyAgentDir, cwd: emptyCwd });
			const graphify = skills.find((skill) => skill.name === "graphify-structural");

			expect(graphify).toMatchObject({
				name: "graphify-structural",
				filePath: graphifySkillPath,
				baseDir: graphifySkillDir,
				sourceInfo: {
					path: graphifySkillPath,
					source: "builtin",
					scope: "user",
					origin: "top-level",
					baseDir: graphifySkillDir,
				},
			});
		});

		it("should keep graphify-structural's static safety contract", () => {
			const skillSource = readFileSync(graphifySkillPath, "utf-8");

			// AST-only extraction and clustering; Graphify is never invoked by this test.
			expect(skillSource).toMatch(/\bAST-only\b/i);
			expect(skillSource).toMatch(
				/graphify\s+extract\s+\.[^\n]*--code-only[^\n]*--no-cluster[^\n]*--max-workers\s+8/,
			);
			expect(skillSource).toMatch(/graphify\s+cluster-only\s+\.[^\n]*--no-viz[^\n]*--no-label/);
			expect(skillSource).toMatch(/graphify\s+update\s+\./);
			expect(skillSource).toMatch(/graphify\s+path\s+"<source-symbol>"\s+"<target-symbol>"/);
			expect(skillSource).toMatch(/GRAPHIFY_QUERY_LOG_DISABLE=1\s+graphify\s+query\b[^\n]*--budget(?:\s|=)\d+\b/);

			// Missing or incompatible CLIs are explicitly non-blocking, so direct-source work continues.
			expect(skillSource).toMatch(/\bmissing\b/i);
			expect(skillSource).toMatch(/\bincompatible\b/i);
			expect(skillSource).toMatch(/\bnon[- ]blocking\b/i);
			expect(skillSource).toMatch(/\bdirect[- ]source\b/i);

			// Preserve Graphify's uncertainty labels and make its prohibited operations explicit.
			expect(skillSource).toMatch(/\bconfidence\b/i);
			expect(skillSource).toMatch(/\bEXTRACTED\b/);
			expect(skillSource).toMatch(/\bINFERRED\b/);
			expect(skillSource).toMatch(/\bAMBIGUOUS\b/);
			expect(skillSource).toMatch(/\b(?:prohibited|forbidden|must not|never)\b/i);
			for (const operation of [
				/install/i,
				/semantic/i,
				/model/i,
				/API/i,
				/MCP/i,
				/watch/i,
				/hook/i,
				/persistent/i,
				/ignore/i,
			]) {
				expect(skillSource).toMatch(operation);
			}
		});

		it("should copy built-in skill and agent sidecars without a Bun binary", () => {
			const distDir = join(packageDir, "dist");
			const originalPackageDir = process.env.DREB_PACKAGE_DIR;
			mkdirSync(distDir, { recursive: true });
			const preservedDir = mkdtempSync(join(distDir, "copy-binary-assets-test-"));
			const preservedAsset = join(preservedDir, "preserved.txt");
			writeFileSync(preservedAsset, "preserve this asset");

			try {
				execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "copy-binary-assets"], {
					cwd: packageDir,
					stdio: "pipe",
				});

				const sidecarSkillPath = join(distDir, "skills", "graphify-structural", "SKILL.md");
				const sidecarAgentPath = join(distDir, "agents", "code-reviewer.md");
				expect(readFileSync(preservedAsset, "utf-8")).toBe("preserve this asset");
				expect(readFileSync(sidecarSkillPath, "utf-8")).toBe(readFileSync(graphifySkillPath, "utf-8"));
				expect(readFileSync(sidecarAgentPath, "utf-8")).toBe(
					readFileSync(join(packageDir, "agents", "code-reviewer.md"), "utf-8"),
				);

				process.env.DREB_PACKAGE_DIR = distDir;
				const { skills } = loadSkills({ agentDir: emptyAgentDir, cwd: emptyCwd });
				const sidecarGraphify = skills.find((skill) => skill.name === "graphify-structural");
				expect(sidecarGraphify).toMatchObject({
					filePath: sidecarSkillPath,
					sourceInfo: { source: "builtin", scope: "user", path: sidecarSkillPath },
				});
			} finally {
				if (originalPackageDir === undefined) {
					delete process.env.DREB_PACKAGE_DIR;
				} else {
					process.env.DREB_PACKAGE_DIR = originalPackageDir;
				}
				expect(process.env.DREB_PACKAGE_DIR).toBe(originalPackageDir);
				rmSync(preservedDir, { recursive: true, force: true });
			}
		});

		it("should allow user/project skills to override built-ins (built-ins are lowest priority)", () => {
			// Load with a fixture skill named "mach6-issue" to collide with the built-in
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "builtin-override")],
			});

			// The path skill should win because built-ins are loaded last (lowest priority)
			const mach6Issue = skills.find((s) => s.name === "mach6-issue");
			expect(mach6Issue).toBeDefined();
			expect(mach6Issue!.sourceInfo.source).not.toBe("builtin");
			expect(mach6Issue!.description).toContain("User override");

			// Built-in should appear as the collision loser, not winner
			const builtinWinners = diagnostics.filter(
				(d: ResourceDiagnostic) => d.type === "collision" && d.collision?.winnerPath?.includes("skills/mach6-"),
			);
			expect(builtinWinners).toHaveLength(0);

			const builtinLosers = diagnostics.filter(
				(d: ResourceDiagnostic) => d.type === "collision" && d.collision?.loserPath?.includes("skills/mach6-"),
			);
			expect(builtinLosers.length).toBeGreaterThan(0);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
