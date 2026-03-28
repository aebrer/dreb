/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { getMemoryInstructions } from "./memory-prompt.js";
import type { MemoryIndexes } from "./resource-loader.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Memory indexes (global and project). */
	memoryIndexes?: MemoryIndexes;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

function formatMemoryScope(sources: import("./resource-loader.js").MemorySource[], heading: string): string {
	if (sources.length === 0) return "";

	const drebSources = sources.filter((s) => s.source === "dreb");
	const claudeSources = sources.filter((s) => s.source === "claude");

	let out = `\n### ${heading}\n`;

	for (const source of drebSources) {
		out += `\n#### dreb memory (${source.path}/)\n\n${source.content}\n`;
	}

	if (claudeSources.length > 0) {
		out += `\n#### Claude Code memory (read-only)\n`;
		out += `> **Note:** These memories were written by Claude Code and may reference Claude Code-specific features, tools, or conventions that don't exist in dreb. Treat the content as useful context, but verify any tool names or workflow references.\n`;
		for (const source of claudeSources) {
			out += `\nSource: ${source.path}/\n\n${source.content}\n`;
		}
	}

	return out;
}

function buildMemorySection(memoryIndexes?: MemoryIndexes): string {
	if (!memoryIndexes) return "";

	// Always include memory instructions so the agent knows the convention
	let section = `\n\n${getMemoryInstructions({ memoryIndexes })}`;

	const { global: globalSources, project: projectSources } = memoryIndexes;

	// Append the actual memory indexes if any exist
	if (globalSources.length > 0 || projectSources.length > 0) {
		section += "\n\n## Current Memory Indexes\n";
		section += formatMemoryScope(globalSources, "Global Memory");
		section += formatMemoryScope(projectSources, "Project Memory");
	}

	return section;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const date = new Date().toISOString().slice(0, 10);

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Append memory indexes
		prompt += buildMemorySection(options.memoryIndexes);

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"web_search",
		"web_fetch",
		"subagent",
	];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside dreb, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Dreb documentation (read only when the user asks about dreb itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), dreb packages (docs/packages.md)
- When working on dreb topics, read the docs and examples, and follow .md cross-references before implementing
- Always read dreb .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Append memory indexes
	prompt += buildMemorySection(options.memoryIndexes);

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
