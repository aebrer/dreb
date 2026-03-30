/**
 * Tests for userInvocable filtering in skill slash commands.
 *
 * Skills with userInvocable: false should be excluded from the autocomplete
 * slash command list but remain invocable via manual /skill:name input
 * (which goes through _expandSkillCommand — see expand-skill-command.test.ts).
 *
 * Covers: issue 47
 */

import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { buildSkillSlashCommands } from "../src/modes/interactive/interactive-mode.js";

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	return {
		description: "A test skill",
		filePath: `/tmp/skills/${overrides.name}/SKILL.md`,
		baseDir: `/tmp/skills/${overrides.name}`,
		sourceInfo: createSyntheticSourceInfo(`/tmp/skills/${overrides.name}/SKILL.md`, { source: "test" }),
		disableModelInvocation: false,
		userInvocable: true,
		...overrides,
	};
}

describe("buildSkillSlashCommands", () => {
	it("includes skills with userInvocable: true (default)", () => {
		const skills = [makeSkill({ name: "my-skill" })];
		const commands = buildSkillSlashCommands(skills);

		expect(commands).toHaveLength(1);
		expect(commands[0].name).toBe("skill:my-skill");
		expect(commands[0].description).toBe("A test skill");
	});

	it("excludes skills with userInvocable: false", () => {
		const skills = [makeSkill({ name: "hidden-skill", userInvocable: false })];
		const commands = buildSkillSlashCommands(skills);

		expect(commands).toHaveLength(0);
	});

	it("filters correctly with mixed userInvocable values", () => {
		const skills = [
			makeSkill({ name: "visible-1" }),
			makeSkill({ name: "hidden", userInvocable: false }),
			makeSkill({ name: "visible-2" }),
		];
		const commands = buildSkillSlashCommands(skills);

		expect(commands).toHaveLength(2);
		expect(commands.map((c) => c.name)).toEqual(["skill:visible-1", "skill:visible-2"]);
	});

	it("appends argumentHint to description when present", () => {
		const skills = [makeSkill({ name: "my-skill", argumentHint: "[PR number]" })];
		const commands = buildSkillSlashCommands(skills);

		expect(commands[0].description).toBe("A test skill (args: [PR number])");
	});

	it("uses formatDescription callback when provided", () => {
		const skills = [makeSkill({ name: "my-skill", description: "Does things" })];
		const commands = buildSkillSlashCommands(skills, (desc, _info) => `[test] ${desc}`);

		expect(commands[0].description).toBe("[test] Does things");
	});

	it("applies formatDescription before appending argumentHint", () => {
		const skills = [makeSkill({ name: "my-skill", description: "Does things", argumentHint: "<url>" })];
		const commands = buildSkillSlashCommands(skills, (desc, _info) => `[proj] ${desc}`);

		expect(commands[0].description).toBe("[proj] Does things (args: <url>)");
	});

	it("returns empty array for empty skills list", () => {
		const commands = buildSkillSlashCommands([]);
		expect(commands).toEqual([]);
	});

	it("returns empty array when all skills are non-user-invocable", () => {
		const skills = [
			makeSkill({ name: "hidden-1", userInvocable: false }),
			makeSkill({ name: "hidden-2", userInvocable: false }),
		];
		const commands = buildSkillSlashCommands(skills);
		expect(commands).toEqual([]);
	});

	// Verify that userInvocable: false skills are still reachable via _expandSkillCommand
	// (tested in expand-skill-command.test.ts — this test just confirms the slash command
	// filtering doesn't affect the skill's existence in the skill registry)
	it("does not modify the input skills array", () => {
		const hiddenSkill = makeSkill({ name: "hidden", userInvocable: false });
		const visibleSkill = makeSkill({ name: "visible" });
		const skills = [hiddenSkill, visibleSkill];

		buildSkillSlashCommands(skills);

		// Skills array should be unchanged — filtering is output-only
		expect(skills).toHaveLength(2);
		expect(skills[0].userInvocable).toBe(false);
		expect(skills[1].userInvocable).toBe(true);
	});
});
