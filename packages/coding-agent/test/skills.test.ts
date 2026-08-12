import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

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

		function getBuiltInSkill(name: string): Skill {
			const { skills } = loadSkills({ agentDir: emptyAgentDir, cwd: emptyCwd });
			const skill = skills.find((candidate) => candidate.name === name && candidate.sourceInfo.source === "builtin");
			expect(skill, `Built-in skill ${name} not found`).toBeDefined();
			return skill!;
		}

		function readBuiltInSkill(name: string): string {
			return readFileSync(getBuiltInSkill(name).filePath, "utf-8");
		}

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
			expect(builtinNames).toContain("model-routing-guide");
		});

		it("model-routing-guide should remain an explicit, skill-only research workflow", () => {
			const guide = getBuiltInSkill("model-routing-guide");
			expect(guide.disableModelInvocation).toBe(true);
			expect(guide.userInvocable).toBe(true);
			expect(guide.description).toContain("skill arguments, or enabledModels when no arguments are supplied");

			const body = readBuiltInSkill("model-routing-guide");
			expect(body).toContain("no special runtime support is required");
			expect(body).toContain("stop with an actionable error before researching or writing a guide");
			expect(body).toContain("unbounded all-model research");
			expect(body).toContain("directory does not exist or contains no session JSONL files");
			expect(body).toContain("cold-start mode");
			expect(body).toContain("every snapshotted file is required evidence");
			expect(body).toContain("every non-empty JSONL line parses");
			expect(body).toContain("stop loudly and identify the affected file");
			expect(body).toContain("do not silently skip it and do not call the run cold-start");
			expect(body).toContain("Agent-role fit");
			expect(body).toContain(
				"Planning, architecture ownership, implementation, editing, and feature development are not Explore work",
			);
			expect(body).toContain("least expensive/lowest-latency selected candidate");
			expect(body).toContain("Vendor claim");
			expect(body).toContain("Measured benchmark");
			expect(body).toContain("Community report");
			expect(body).toContain("Local observation");
			expect(body).toContain("active research model");
			expect(body).toContain("do not claim the analysis remains entirely local");
			expect(body).toContain("must never reproduce or closely paraphrase");
			expect(body).toContain("schema_version: 1");
			expect(body).toContain("They must be identical with no duplicates, missing entries, or extras");
		});

		it("model-routing-guide should select one factual scope source without searching session state", () => {
			const body = readBuiltInSkill("model-routing-guide");
			expect(body).toContain("exactly two supported scope sources");
			expect(body).toContain("choose one source, and then stop looking for scope");
			expect(body).toContain("That argument list is the complete authoritative scope");
			expect(body).toContain("A non-empty effective `enabledModels` array is the complete authoritative scope");
			expect(body).toContain("does **not** receive the current session's runtime `--models` value");
			expect(body).toContain("they must pass the same comma-separated patterns as skill arguments");
			expect(body).toContain("Run `dreb --list-models`");
			expect(body).toContain("it never means an undiscovered runtime/session scope");
			expect(body).not.toContain("user's actual scoped provider/model combinations");
		});

		it("model-routing-guide should incrementally update rotated model scopes", () => {
			const guide = getBuiltInSkill("model-routing-guide");
			expect(guide.argumentHint).toContain("update");

			const body = readBuiltInSkill("model-routing-guide");
			expect(body).toContain("optional first argument `update` selects UPDATE mode");
			expect(body).toContain("validate its internal coverage against its own `covered_model_ids`");
			expect(body).toContain("**retained**");
			expect(body).toContain("**removed**");
			expect(body).toContain("**added**");
			expect(body).toContain("Preserve retained model sections");
			expect(body).toContain("Fully research every added canonical provider/model");
			expect(body).toContain("atomically replace the old file");
		});

		it("mach6 planning workflows keep synthesis out of Explore tasks", () => {
			for (const name of ["mach6-plan", "mach6-issue"]) {
				const body = readBuiltInSkill(name);
				expect(body).toContain("concrete evidence retrieval");
				expect(body).toContain("Do not ask Explore");
				expect(body).toContain("primary agent synthesize");
				expect(body).not.toContain("**Architecture**: Map relevant architecture layers");
			}
		});

		it("mach6-issue should preserve CREATE-mode scope and posting guardrails", () => {
			const body = readBuiltInSkill("mach6-issue");
			expect(body).toContain("Never create an issue in the same turn as that initial request");
			expect(body).toContain("user's original request/input verbatim");
			expect(body).toContain("do not paraphrase, correct, or omit any part of it");
			expect(body).toContain("Before adding any acceptance criterion that the user did not explicitly ask for");
			expect(body).toContain("do not treat approval of the completed issue draft as retroactive scope confirmation");
			expect(body).toContain("The exact target `owner/repo`");
			expect(body).toContain("The complete issue title");
			expect(body).toContain("including the verbatim **Original Request** block quote");
			expect(body).toContain(
				"The complete proposed label list, or an explicit statement that no labels are proposed",
			);
			expect(body).toContain("- **Approve**");
			expect(body).toContain("- **Deny/Discuss**");
			expect(body).toContain("- **Detailed Explanation with minimal jargon of each acceptance criteria**");
			expect(body).toContain("Free text, a skipped or unanswered question, cancellation");
			expect(body).toContain("title, body, target repository, or proposed labels invalidates prior approval");
			expect(body).toContain('gh issue create --repo "<owner/repo>"');
		});

		it("mach6 CI workflows use watch_github_ci instead of polling or wait", () => {
			for (const name of ["mach6-implement", "mach6-publish"]) {
				const body = readBuiltInSkill(name);
				expect(body).toContain("`watch_github_ci`");
				expect(body).toContain("Do not use `wait`, sleep, or repeated polling commands for CI");
				expect(body).not.toContain("exit code 8 while checks are still pending");
			}
		});

		it("mach6-review should be durable, round-aware, and counter-pressured", () => {
			const review = getBuiltInSkill("mach6-review");
			expect(review.disableModelInvocation).toBe(false);
			expect(review.userInvocable).toBe(true);
			const body = readBuiltInSkill("mach6-review");
			expect(body).toContain("explicit user request");
			expect(body).toContain("never invoke it autonomously or start a review-fix-review loop");
			expect(body).toContain(`PR_HEAD="$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')"`);
			expect(body).toContain("PRIOR_ROUNDS");
			expect(body).toContain('REVIEW_ROUND="$((PRIOR_ROUNDS + 1))"');
			expect(body).toContain("Reviewed commit:");
			expect(body).toContain("Review round:");
			expect(body).toContain("Unverified Review Candidates — Pending Assessment");
			expect(body).toContain("git diff <sha>..HEAD");
			expect(body).toContain("Reject unchanged-code findings");
			expect(body).toContain("verify that each is fixed");
			expect(body).toContain("one parallel `subagent` `tasks` call");
			expect(body).toContain("Skip `simplifier` unless `simplify` was explicitly requested");
			for (const agent of [
				"code-reviewer",
				"error-auditor",
				"test-reviewer",
				"completeness-checker",
				"independent-assessor",
				"developers-advocate",
				"devils-advocate",
			])
				expect(body).toContain(`\`${agent}\``);
			expect(body).toContain(
				"both the independent assessor and developer's advocate find material practical impact",
			);
			expect(body).toContain("concrete actor, exact reachable trigger sequence");
			expect(body).toContain("<!-- mach6-review -->");
			expect(body).toContain("<!-- mach6-assessment -->");
			expect(body).toContain("merge blockers only");
		});

		it("mach6-publish should watch CI once after final push and authorize pushes", () => {
			const body = readBuiltInSkill("mach6-publish");
			expect(body.match(/watch_github_ci/g)).toHaveLength(1);
			const finalPush = body.indexOf("After the final pre-merge push");
			const watch = body.indexOf("watch_github_ci");
			const merge = body.indexOf("gh pr merge");
			expect(watch).toBeGreaterThan(finalPush);
			expect(merge).toBeGreaterThan(watch);
			expect(body).toContain("version-bump push, documentation push, and tag push directly without asking");
		});

		it("mach6-implement should keep reasoning with the parent and stop before formal review", () => {
			const body = readBuiltInSkill("mach6-implement");
			const sharedRules = body.slice(body.indexOf("## Parent ownership"), body.indexOf("## Step 1"));
			const implementMode = body.slice(body.indexOf("## Implement Mode"), body.indexOf("## Fix Mode"));
			const implementExecution = implementMode.slice(
				implementMode.indexOf("### Step 6i"),
				implementMode.indexOf("### Step 7i"),
			);
			const implementVerification = implementMode.slice(implementMode.indexOf("### Step 7i"));
			const fixMode = body.slice(body.indexOf("## Fix Mode"));
			const fixExecution = fixMode.slice(fixMode.indexOf("### Step 6f"), fixMode.indexOf("### Step 7f"));
			const fixVerification = fixMode.slice(fixMode.indexOf("### Step 7f"));

			expect(sharedRules).toContain("These rules apply in both implement and fix modes");
			expect(sharedRules).toContain("The parent model owns implementation reasoning");
			expect(sharedRules).toContain("Direct implementation is generally acceptable");
			expect(sharedRules).toContain("Every delegated task must be clear, detailed, and specific");
			expect(sharedRules).toContain("Focused checks remain allowed");
			expect(sharedRules).toContain("narrow correctness question or second opinion");
			expect(sharedRules).toContain("formal mach6 multi-agent review/assessment workflow");
			expect(sharedRules).toContain("accountability and recovery boundary");
			expect(sharedRules).toContain("Only the user starts formal `mach6-review`");

			expect(implementExecution).toContain("first decide the implementation yourself");
			expect(implementExecution).toContain(
				"Direct parent implementation is generally acceptable regardless of plan size",
			);
			expect(implementExecution).toContain("high-volume, repetitive, and mechanically specified");
			expect(implementExecution).toContain("Exact files or a precisely bounded file set");
			expect(implementExecution).toContain("Specific changes and content-dependent decision rules");
			expect(implementExecution).toContain("Existing code patterns and constraints to preserve");
			expect(implementExecution).toContain("Required tests, linting, and validation commands");
			expect(implementExecution).toContain("Expected observable result and completion criteria");
			expect(implementExecution).toContain("without inventing design decisions");
			expect(implementVerification).toContain("committed, pushed, and recorded");
			expect(implementVerification).toContain("Do **not** invoke `mach6-review`");
			expect(implementVerification).toContain("Use `suggest_next` to offer `/skill:mach6-push`, then end the turn");

			expect(fixExecution).toContain("the parent must verify the assessment against the current code");
			expect(fixExecution).toContain("Implement fixes directly by default");
			expect(fixExecution).toContain("high-volume, repetitive, mechanically settled execution");
			expect(fixExecution).toContain("Exact files and code locations, or a precisely bounded file set");
			expect(fixExecution).toContain("The complete fix design and content-dependent decision rules");
			expect(fixExecution).toContain("Existing patterns and constraints to preserve");
			expect(fixExecution).toContain("Required regression tests and validation commands");
			expect(fixExecution).toContain("Expected result and completion criteria");
			expect(fixExecution).toContain("Do not ask `feature-dev` to determine the design");
			expect(fixVerification).toContain("committed, pushed, and recorded");
			expect(fixVerification).toContain("Do **not** invoke `mach6-review`");
			expect(fixVerification).toContain("Use `suggest_next` to offer `/skill:mach6-push`, then end the turn");
		});

		it("mach6-push should stop after saving work and leave review to the user", () => {
			const body = readBuiltInSkill("mach6-push");
			const commitStep = body.indexOf("## Step 3: Commit");
			const pushStep = body.indexOf("## Step 4: Push");
			const commentStep = body.indexOf("## Step 5: Post progress comment");
			const finalWorkflow = body.slice(commentStep);

			expect(commitStep).toBeGreaterThan(-1);
			expect(pushStep).toBeGreaterThan(commitStep);
			expect(commentStep).toBeGreaterThan(pushStep);
			expect(finalWorkflow).toContain('gh pr comment <number> --body-file "$GH_BODY"');
			const commentCompleted = finalWorkflow.indexOf("Update task: comment → completed");
			expect(commentCompleted).toBeGreaterThan(finalWorkflow.indexOf("gh pr comment"));
			expect(finalWorkflow.indexOf("Stop here")).toBeGreaterThan(commentCompleted);
			expect(finalWorkflow).toContain("Do not invoke `mach6-review`");
			expect(finalWorkflow).toContain("Use `suggest_next` for exactly one context-appropriate command");
			expect(finalWorkflow).toContain("If on a feature branch with a PR: `/skill:mach6-review <pr-number>`");
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
