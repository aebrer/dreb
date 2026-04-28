import { describe, expect, test } from "vitest";
import type { GitRepoState } from "../src/core/git-repo-state.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("exploration guidelines", () => {
		test("includes search-first guidance when search tool is available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "grep", "find", "ls", "search"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Start with `search`");
			expect(prompt).not.toContain("Prefer grep/find/ls tools over bash");
		});

		test("falls back to grep/find guidance when search is not available", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["bash", "grep", "find", "ls"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Prefer grep/find/ls tools over bash");
			expect(prompt).not.toContain("Start with `search`");
		});
	});

	describe("git repo state", () => {
		const fullState: GitRepoState = {
			branch: "feature/foo-bar",
			dirtyCount: 3,
			recentCommits: [
				{ hash: "abc1234", subject: "most recent commit" },
				{ hash: "def5678", subject: "second recent commit" },
			],
			recentTags: [
				{ name: "v1.2.3", date: "2 days ago" },
				{ name: "v1.2.2", date: "3 weeks ago" },
			],
			openPRs: [{ number: 42, title: "Add feature X", url: "https://github.com/org/repo/pull/42" }],
		};

		test("full state renders correctly", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: fullState,
			});

			expect(prompt).toContain("## Project state (true at session start only)");
			expect(prompt).toContain("- Branch: `feature/foo-bar`");
			expect(prompt).toContain("- Status: 3 uncommitted changes");
			expect(prompt).toContain("- Recent commits:");
			expect(prompt).toContain("  - `abc1234 — most recent commit`");
			expect(prompt).toContain("  - `def5678 — second recent commit`");
			expect(prompt).toContain("- Recent releases:");
			expect(prompt).toContain("  - `v1.2.3` (2 days ago)");
			expect(prompt).toContain("  - `v1.2.2` (3 weeks ago)");
			expect(prompt).toContain("- Open PRs on this branch:");
			expect(prompt).toContain("  - PR 42 — Add feature X (https://github.com/org/repo/pull/42)");
		});

		test("clean status", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: { ...fullState, dirtyCount: 0 },
			});

			expect(prompt).toContain("- Status: clean");
		});

		test("dirty status", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: { ...fullState, dirtyCount: 5 },
			});

			expect(prompt).toContain("- Status: 5 uncommitted changes");
		});

		test("omitted when undefined", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).not.toContain("Project state");
		});

		test("partial data — no tags, no PRs", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: {
					branch: "main",
					dirtyCount: 1,
					recentCommits: [{ hash: "aaa1111", subject: "fix bug" }],
					recentTags: [],
					openPRs: [],
				},
			});

			expect(prompt).toContain("- Branch: `main`");
			expect(prompt).toContain("- Status: 1 uncommitted change");
			expect(prompt).toContain("- Recent commits:");
			expect(prompt).toContain("  - `aaa1111 — fix bug`");
			expect(prompt).not.toContain("Recent releases");
			expect(prompt).not.toContain("Open PRs");
		});

		test("detached HEAD", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: { ...fullState, branch: "detached" },
			});

			expect(prompt).toContain("- Branch: `detached`");
		});

		test("works with custom prompt", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "Custom prompt.",
				contextFiles: [],
				skills: [],
				gitRepoState: fullState,
			});

			expect(prompt).toContain("Custom prompt.");
			expect(prompt).toContain("## Project state (true at session start only)");
		});

		test("section appears before date", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				gitRepoState: fullState,
			});

			const stateIdx = prompt.indexOf("## Project state");
			const dateIdx = prompt.indexOf("Current date:");
			expect(stateIdx).toBeGreaterThan(-1);
			expect(dateIdx).toBeGreaterThan(-1);
			expect(stateIdx).toBeLessThan(dateIdx);
		});
	});
});
