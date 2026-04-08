import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDrebToolVisibleDirs } from "../../src/core/tools/dreb-paths.js";

describe("getDrebToolVisibleDirs", () => {
	let fixtureDir: string;

	beforeAll(() => {
		fixtureDir = mkdtempSync(path.join(tmpdir(), "dreb-paths-test-"));

		const drebDir = path.join(fixtureDir, ".dreb");

		// Tool-visible dirs
		mkdirSync(path.join(drebDir, "memory"), { recursive: true });
		mkdirSync(path.join(drebDir, "agents"), { recursive: true });
		mkdirSync(path.join(drebDir, "extensions"), { recursive: true });

		// Tool-hidden dirs (blocklisted)
		mkdirSync(path.join(drebDir, "index"), { recursive: true });
		mkdirSync(path.join(drebDir, "agent"), { recursive: true });
		mkdirSync(path.join(drebDir, "secrets"), { recursive: true });

		// A file in .dreb/ (not a directory — should be excluded)
		writeFileSync(path.join(drebDir, "CONTEXT.md"), "# Context", "utf-8");
	});

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	it("returns empty array when .dreb/ does not exist", () => {
		const emptyDir = mkdtempSync(path.join(tmpdir(), "dreb-paths-empty-"));
		try {
			expect(getDrebToolVisibleDirs(emptyDir)).toEqual([]);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});

	it("includes memory, agents, and extensions directories", () => {
		const dirs = getDrebToolVisibleDirs(fixtureDir);
		const names = dirs.map((d) => path.basename(d));

		expect(names).toContain("memory");
		expect(names).toContain("agents");
		expect(names).toContain("extensions");
	});

	it("excludes index, agent, and secrets directories", () => {
		const dirs = getDrebToolVisibleDirs(fixtureDir);
		const names = dirs.map((d) => path.basename(d));

		expect(names).not.toContain("index");
		expect(names).not.toContain("agent");
		expect(names).not.toContain("secrets");
	});

	it("excludes top-level files (only directories)", () => {
		const dirs = getDrebToolVisibleDirs(fixtureDir);
		const names = dirs.map((d) => path.basename(d));

		expect(names).not.toContain("CONTEXT.md");
	});

	it("returns absolute paths", () => {
		const dirs = getDrebToolVisibleDirs(fixtureDir);
		for (const dir of dirs) {
			expect(path.isAbsolute(dir)).toBe(true);
		}
	});

	it("includes user-created subdirectories not in blocklist", () => {
		const customDir = path.join(fixtureDir, ".dreb", "custom-stuff");
		mkdirSync(customDir, { recursive: true });
		try {
			const dirs = getDrebToolVisibleDirs(fixtureDir);
			const names = dirs.map((d) => path.basename(d));
			expect(names).toContain("custom-stuff");
		} finally {
			rmSync(customDir, { recursive: true, force: true });
		}
	});
});
