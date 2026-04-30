import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findGitRoot } from "../src/core/git-root.js";
import { getMemoryInstructions } from "../src/core/memory-prompt.js";
import { encodeClaudeProjectPath, type MemoryIndexes, type MemorySource } from "../src/core/resource-loader.js";
import { buildSystemPrompt, formatDreamAge } from "../src/core/system-prompt.js";

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
	dreamLastRun?: string | null;
}): MemoryIndexes {
	const globalDir = opts.globalDir ?? "/home/user/.dreb/memory";
	const projectDir = opts.projectDir ?? "/project/.dreb/memory";
	const globalSources: MemorySource[] = [];
	const projectSources: MemorySource[] = [];

	if (opts.global) {
		globalSources.push({
			content: opts.global,
			dir: globalDir,
			source: opts.globalSource ?? "dreb",
		});
	}
	if (opts.project) {
		projectSources.push({
			content: opts.project,
			dir: projectDir,
			source: opts.projectSource ?? "dreb",
		});
	}

	return {
		global: globalSources,
		project: projectSources,
		globalMemoryDir: globalDir,
		projectMemoryDir: projectDir,
		dreamLastRun: opts.dreamLastRun ?? null,
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
				{ content: "- [Dreb global](dreb.md) — from dreb", dir: "/home/user/.dreb/memory", source: "dreb" },
				{
					content: "- [Claude global](claude.md) — from claude",
					dir: "/home/user/.claude/projects/-home-user/memory",
					source: "claude",
				},
			],
			project: [],
			globalMemoryDir: "/home/user/.dreb/memory",
			projectMemoryDir: "/project/.dreb/memory",
			dreamLastRun: null,
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
			globalMemoryDir: "/home/user/.dreb/memory",
			projectMemoryDir: "/project/.dreb/memory",
		});
		expect(instructions).toContain("user-preferences");
		expect(instructions).toContain("good-practices");
		expect(instructions).toContain("### project");
		expect(instructions).toContain("navigation");
	});

	test("includes memory directories in instructions", () => {
		const instructions = getMemoryInstructions({
			globalMemoryDir: "/custom/global/memory",
			projectMemoryDir: "/custom/project/memory",
		});
		expect(instructions).toContain("/custom/global/memory/");
		expect(instructions).toContain("/custom/project/memory/");
	});

	test("includes save and access conventions", () => {
		const instructions = getMemoryInstructions({
			globalMemoryDir: "/home/user/.dreb/memory",
			projectMemoryDir: "/project/.dreb/memory",
		});
		expect(instructions).toContain("How to Save Memory");
		expect(instructions).toContain("When to Access Memory");
		expect(instructions).toContain("What NOT to Save");
		expect(instructions).toContain("YAML frontmatter");
		expect(instructions).toContain("Staleness Warning");
	});

	test("references .dreb/CONTEXT.md not bare CONTEXT.md", () => {
		const instructions = getMemoryInstructions({
			globalMemoryDir: "/home/user/.dreb/memory",
			projectMemoryDir: "/project/.dreb/memory",
		});
		expect(instructions).toContain(".dreb/CONTEXT.md");
	});
});

describe("encodeClaudeProjectPath", () => {
	test("replaces slashes with hyphens", () => {
		expect(encodeClaudeProjectPath("/home/drew/projects/dreb")).toBe("-home-drew-projects-dreb");
	});

	test("replaces underscores with hyphens", () => {
		expect(encodeClaudeProjectPath("/home/drew/projects/deep_yellow")).toBe("-home-drew-projects-deep-yellow");
	});

	test("handles homedir path", () => {
		expect(encodeClaudeProjectPath("/home/drew")).toBe("-home-drew");
	});

	test("handles mixed underscores and slashes", () => {
		expect(encodeClaudeProjectPath("/home/user_name/my_project/sub_dir")).toBe("-home-user-name-my-project-sub-dir");
	});
});

describe("readMemoryIndex via DefaultResourceLoader", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir("memory-load");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("truncates MEMORY.md at 200 lines", async () => {
		// Create a git repo so project root resolves to tempDir
		mkdirSync(join(tempDir, ".git"));

		// Create a global memory dir with an oversized MEMORY.md
		const memoryDir = join(tempDir, ".dreb-global", "memory");
		mkdirSync(memoryDir, { recursive: true });

		const lines = Array.from({ length: 250 }, (_, i) => `- [Memory ${i}](mem_${i}.md) — entry ${i}`);
		writeFileSync(join(memoryDir, "MEMORY.md"), lines.join("\n"));

		// Create project-scoped memory (tempDir is the git root, so project memory resolves here)
		const projectMemoryDir = join(tempDir, ".dreb", "memory");
		mkdirSync(projectMemoryDir, { recursive: true });
		writeFileSync(join(projectMemoryDir, "MEMORY.md"), lines.join("\n"));

		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, ".dreb-global"),
		});
		await loader.reload();

		const indexes2 = loader.getMemoryIndexes();

		const projectSources = indexes2.project;
		expect(projectSources.length).toBeGreaterThan(0);

		const projectContent = projectSources[0].content;
		const loadedLines = projectContent.split("\n");
		expect(loadedLines.length).toBe(200);
		expect(loadedLines[0]).toBe("- [Memory 0](mem_0.md) — entry 0");
		expect(loadedLines[199]).toBe("- [Memory 199](mem_199.md) — entry 199");
	});

	test("reads .dream-last-run timestamp when present", async () => {
		mkdirSync(join(tempDir, ".git"));

		// globalMemoryDir resolves to join(resolve(agentDir, ".."), "memory") = join(tempDir, "memory")
		const memoryDir = join(tempDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, ".dream-last-run"), "2026-04-20T12:00:00.000Z");

		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, ".dreb-global"),
		});
		await loader.reload();

		const indexes = loader.getMemoryIndexes();
		expect(indexes.dreamLastRun).toBe("2026-04-20T12:00:00.000Z");
	});

	test("returns null dreamLastRun when file is missing", async () => {
		mkdirSync(join(tempDir, ".git"));

		const memoryDir = join(tempDir, ".dreb-global", "memory");
		mkdirSync(memoryDir, { recursive: true });
		// No .dream-last-run file

		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, ".dreb-global"),
		});
		await loader.reload();

		const indexes = loader.getMemoryIndexes();
		expect(indexes.dreamLastRun).toBeNull();
	});

	test("returns null dreamLastRun when file contains garbage", async () => {
		mkdirSync(join(tempDir, ".git"));

		const memoryDir = join(tempDir, ".dreb-global", "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, ".dream-last-run"), "not a valid timestamp");

		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, ".dreb-global"),
		});
		await loader.reload();

		const indexes = loader.getMemoryIndexes();
		expect(indexes.dreamLastRun).toBeNull();
	});

	test("returns null dreamLastRun when file is empty", async () => {
		mkdirSync(join(tempDir, ".git"));

		const memoryDir = join(tempDir, ".dreb-global", "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, ".dream-last-run"), "");

		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, ".dreb-global"),
		});
		await loader.reload();

		const indexes = loader.getMemoryIndexes();
		expect(indexes.dreamLastRun).toBeNull();
	});
});

describe("formatDreamAge", () => {
	const now = new Date("2026-04-30T12:00:00.000Z");

	test("returns 'Never' for null", () => {
		expect(formatDreamAge(null, now)).toBe("Never");
	});

	test("returns 'Never' for invalid timestamp", () => {
		expect(formatDreamAge("garbage", now)).toBe("Never");
	});

	test("returns 'just now' for future timestamp", () => {
		expect(formatDreamAge("2026-05-01T00:00:00.000Z", now)).toBe("just now");
	});

	test("returns 'less than an hour ago' for 30 minutes", () => {
		expect(formatDreamAge("2026-04-30T11:30:00.000Z", now)).toBe("less than an hour ago");
	});

	test("returns '1 hour ago' for 1 hour", () => {
		expect(formatDreamAge("2026-04-30T11:00:00.000Z", now)).toBe("1 hour ago");
	});

	test("returns '23 hours ago' for 23 hours", () => {
		expect(formatDreamAge("2026-04-29T13:00:00.000Z", now)).toBe("23 hours ago");
	});

	test("returns '1 day ago' for 24 hours", () => {
		expect(formatDreamAge("2026-04-29T12:00:00.000Z", now)).toBe("1 day ago");
	});

	test("returns '7 days ago' for one week", () => {
		expect(formatDreamAge("2026-04-23T12:00:00.000Z", now)).toBe("7 days ago");
	});

	test("returns '30 days ago' for one month", () => {
		expect(formatDreamAge("2026-03-31T12:00:00.000Z", now)).toBe("30 days ago");
	});
});

describe("dream age in system prompt", () => {
	test("shows 'Memory last consolidated: Never' when dreamLastRun is null", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({}),
		});
		expect(prompt).toContain("Memory last consolidated: Never");
	});

	test("shows date and relative age when dreamLastRun is set", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ dreamLastRun: "2026-04-20T12:00:00.000Z" }),
		});
		expect(prompt).toContain("Memory last consolidated: 2026-04-20");
		expect(prompt).toMatch(/Memory last consolidated: 2026-04-20 \(\d+ days ago\)/);
	});

	test("dream age appears before Current Memory Indexes", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({
				global: "- [Test](test.md) — test entry",
				dreamLastRun: "2026-04-20T12:00:00.000Z",
			}),
		});
		const ageIdx = prompt.indexOf("Memory last consolidated:");
		const indexesIdx = prompt.indexOf("## Current Memory Indexes");
		expect(ageIdx).toBeGreaterThan(-1);
		expect(indexesIdx).toBeGreaterThan(ageIdx);
	});

	test("dream age works with custom prompt", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "You are a custom agent.",
			selectedTools: ["read"],
			contextFiles: [],
			skills: [],
			memoryIndexes: makeIndexes({ dreamLastRun: "2026-04-25T08:00:00.000Z" }),
		});
		expect(prompt).toContain("Memory last consolidated: 2026-04-25");
	});
});
