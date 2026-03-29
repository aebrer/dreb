import { readFileSync } from "node:fs";
import type { AgentTool } from "@dreb/agent-core";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import { stripFrontmatter } from "../../utils/frontmatter.js";
import type { ToolDefinition } from "../extensions/types.js";
import { parseCommandArgs, substituteArgs } from "../prompt-templates.js";
import type { Skill } from "../skills.js";
import { getTextOutput } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const skillSchema = Type.Object({
	skill: Type.String({ description: 'The skill name to invoke (e.g. "review-pr", "telegram-send")' }),
	args: Type.Optional(Type.String({ description: "Optional arguments to pass to the skill" })),
});

export type SkillToolInput = Static<typeof skillSchema>;

export interface SkillToolDetails {
	skillName: string;
	found: boolean;
	warned: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SkillToolOptions {
	/** Returns the current list of loaded skills. Called on each invocation so reloads are reflected. */
	getSkills: () => Skill[];
	/** Returns the current session ID for ${DREB_SESSION_ID} substitution. Called on each invocation so session rotations are reflected. */
	getSessionId: () => string;
}

// ---------------------------------------------------------------------------
// Skill expansion (shared with _expandSkillCommand in agent-session)
// ---------------------------------------------------------------------------

function expandSkillContent(skill: Skill, args: string, sessionId: string): string {
	const content = readFileSync(skill.filePath, "utf-8");
	let body = stripFrontmatter(content).trim();

	const parsedArgs = parseCommandArgs(args);
	body = substituteArgs(body, parsedArgs);
	// $0 is an alias for first argument (per spec)
	body = body.replace(/\$0/g, parsedArgs[0] ?? "");
	// Environment-style placeholders
	body = body.replace(/\$\{DREB_SKILL_DIR\}/g, skill.baseDir);
	body = body.replace(/\$\{DREB_SESSION_ID\}/g, sessionId);

	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createSkillToolDefinition(
	_cwd: string,
	options: SkillToolOptions,
): ToolDefinition<typeof skillSchema, SkillToolDetails> {
	const { getSkills, getSessionId } = options;

	return {
		name: "skill",
		label: "skill",
		description:
			"Invoke a skill by name. Skills provide specialized instructions for specific tasks. " +
			"Use this tool when a task matches a skill's description from the available_skills list in the system prompt.",
		promptSnippet: "Invoke a skill to get specialized instructions for a task",
		parameters: skillSchema,

		async execute(_toolCallId, params: { skill: string; args?: string }) {
			const skills = getSkills();
			const skill = skills.find((s) => s.name === params.skill);

			if (!skill) {
				const available = skills
					.filter((s) => !s.disableModelInvocation)
					.map((s) => `  - ${s.name}: ${s.description}`)
					.join("\n");
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown skill "${params.skill}". Available skills:\n${available || "  (none loaded)"}`,
						},
					],
					details: { skillName: params.skill, found: false, warned: false },
				};
			}

			if (skill.disableModelInvocation) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`The skill "${skill.name}" has model invocation disabled. ` +
								`This skill is intended to be invoked explicitly by the user (via /skill:${skill.name}), not by the model. ` +
								`Please ask the user for clarification before proceeding.`,
						},
					],
					details: { skillName: skill.name, found: true, warned: true },
				};
			}

			try {
				const expanded = expandSkillContent(skill, params.args ?? "", getSessionId());
				return {
					content: [{ type: "text" as const, text: expanded }],
					details: { skillName: skill.name, found: true, warned: false },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error loading skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { skillName: skill.name, found: true, warned: false },
				};
			}
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const skillName = args?.skill ?? "...";
			const argsStr = args?.args ? ` ${theme.fg("accent", args.args)}` : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("skill"))} ${theme.fg("accent", skillName)}${argsStr}`);
			return text;
		},

		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(getTextOutput(result, context.showImages));
			return text;
		},
	};
}

export function createSkillTool(cwd: string, options: SkillToolOptions): AgentTool<typeof skillSchema> {
	return wrapToolDefinition(createSkillToolDefinition(cwd, options));
}
