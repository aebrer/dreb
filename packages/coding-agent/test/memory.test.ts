import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findGitRoot } from "../src/core/git-root.js";
import { getMemoryInstructions } from "../src/core/memory-prompt.js";
import type { MemoryIndexes, MemorySource } from "../src/core/resource-loader.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

// Helper to create a unique temp directory for each test
function createTempDir(prefix: string): string {
	const dir = join(tmpdir(), `dreb-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Helper to build MemoryIndexes with MemorySource arrays
function makeIndexes(opts: {
	global?: string;
	project?: string;
	globalDir?: string;
	projectDir?: string;
	globalSource?: "dreb" | "claude";
	projectSource?: "dreb" | "claude";
}): MemoryIndexes {
	const globalDir = opts.globalDir ?? "/home/user/.dreb/memory";
	const projectDir = opts.projectDir ?? "/project/.dreb/memory";
	const globalSources: MemorySource[] = [];
	const projectSources: MemorySource[] = [];

	if (opts.global) {
		globalSources.push({
			content: opts.global,
			path: globalDir,
			source: opts.globalSource ?? "dreb",
		});
	}
	if (opts.project) {
		projectSources.push({
			content: opts.project,
			path: projectDir,
			source: opts.projectSource ?? "dreb",
		});
	}

	return {
		global: globalSources,
		project: projectSources,
		globalMemoryDir: globalDir,
		projectMemoryDir: projectDir,
	};
}

describe("findGitRoot", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir("git-root");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("returns null when no .git exists", () => {
		expect(findGitRoot(tempDir)).toBeNull();
	});

	test("finds .git directory in current dir", () => {
		mkdirSync(join(tempDir, ".git"));
		expect(findGitRoot(tempDir)).toBe(tempDir);
	});

	test("finds .git directory in parent dir", () => {
		mkdirSync(join(tempDir, ".git"));
		const subdir = join(tempDir, "src", "core");
		mkdirSync(subdir, { recursive: true });
		expect(findGitRoot(subdir)).toBe(tempDir);
	});

	test("handles .git file (worktree)", () => {
		writeFileSync(join(tempDir, ".git"), "gitdir: /some/path/.git/worktrees/branch");
		expect(findGitRoot(tempDir)).toBe(tempDir);
	});

	test("finds nearest .git when nested", () => {
		// Outer repo
		mkdirSync(join(tempDir, ".git"));
		// Inner repo (submodule-like)
		const inner = join(tempDir, "vendor", "lib");
		mkdirSync(inner, { recursive: true });
		mkdirSync(join(tempDir, "vendor", ".git"));
		expect(findGitRoot(inner)).toBe(join(tempDir, "vendor"));
	});
});

describe("buildSystemPrompt with memory", () => {
	test("omits memory section when memoryIndexes is undefined", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
		});
		expect(prompt).not.toContain("# Memory");
	});

	test("includes memory instructions when memoryIndexes is provided (even without indexes)", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({}),
		});
		expect(prompt).toContain("# Memory System");
		expect(prompt).toContain("/home/user/.dreb/memory/");
		expect(prompt).toContain("/project/.dreb/memory/");
	});

	test("includes global memory index content", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ global: "- [User role](user_role.md) — data scientist" }),
		});
		expect(prompt).toContain("### Global Memory");
		expect(prompt).toContain("data scientist");
	});

	test("includes project memory index content", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ project: "- [Auth rewrite](project_auth.md) — compliance driven" }),
		});
		expect(prompt).toContain("### Project Memory");
		expect(prompt).toContain("compliance driven");
	});

	test("includes both memory indexes", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({
				global: "- [User role](user_role.md) — data scientist",
				project: "- [Auth rewrite](project_auth.md) — compliance driven",
			}),
		});
		expect(prompt).toContain("### Global Memory");
		expect(prompt).toContain("### Project Memory");
	});

	test("memory section appears before date/cwd", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ global: "- [User role](user_role.md) — test" }),
		});
		const memoryIdx = prompt.indexOf("# Memory System");
		const dateIdx = prompt.indexOf("Current date:");
		expect(memoryIdx).toBeGreaterThan(-1);
		expect(dateIdx).toBeGreaterThan(memoryIdx);
	});

	test("works with custom prompt path", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "You are a custom agent.",
			selectedTools: ["read"],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ global: "- [Feedback](feedback.md) — no mocks" }),
		});
		expect(prompt).toContain("You are a custom agent.");
		expect(prompt).toContain("# Memory System");
		expect(prompt).toContain("no mocks");
	});

	test("handles claude-sourced memory", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({
				global: "- [User role](user_role.md) — from claude",
				globalSource: "claude",
				globalDir: "/home/user/.claude/projects/-home-user/memory",
			}),
		});
		expect(prompt).toContain("from claude");
		expect(prompt).toContain("### Global Memory");
	});

	test("handles multiple sources in same scope", () => {
		const indexes: MemoryIndexes = {
			global: [
				{ content: "- [Dreb global](dreb.md) — from dreb", path: "/home/user/.dreb/memory", source: "dreb" },
				{
					content: "- [Claude global](claude.md) — from claude",
					path: "/home/user/.claude/projects/-home-user/memory",
					source: "claude",
				},
			],
			project: [],
			globalMemoryDir: "/home/user/.dreb/memory",
			projectMemoryDir: "/project/.dreb/memory",
		};
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: indexes,
		});
		expect(prompt).toContain("from dreb");
		expect(prompt).toContain("from claude");
	});
});

describe("getMemoryInstructions", () => {
	test("includes all four memory types", () => {
		const instructions = getMemoryInstructions({
			memoryIndexes: makeIndexes({}),
		});
		expect(instructions).toContain("user-preferences");
		expect(instructions).toContain("good-practices");
		expect(instructions).toContain("### project");
		expect(instructions).toContain("navigation");
	});

	test("includes memory directories in instructions", () => {
		const instructions = getMemoryInstructions({
			memoryIndexes: makeIndexes({
				globalDir: "/custom/global/memory",
				projectDir: "/custom/project/memory",
			}),
		});
		expect(instructions).toContain("/custom/global/memory/");
		expect(instructions).toContain("/custom/project/memory/");
	});

	test("includes save and access conventions", () => {
		const instructions = getMemoryInstructions({
			memoryIndexes: makeIndexes({}),
		});
		expect(instructions).toContain("How to Save Memory");
		expect(instructions).toContain("When to Access Memory");
		expect(instructions).toContain("What NOT to Save");
		expect(instructions).toContain("YAML frontmatter");
		expect(instructions).toContain("Staleness Warning");
	});
});
