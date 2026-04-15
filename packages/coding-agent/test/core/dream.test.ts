import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireDreamLock,
	type BackupResult,
	buildDreamPrompt,
	cleanupDreamTmpDirs,
	type DreamContext,
	discoverAllProjectMemoryDirs,
	parseDreamCommand,
	performDreamBackup,
	pruneOldBackups,
	validateArchivePath,
	validateMemoryLinks,
} from "../../src/core/dream.js";

describe("dream", () => {
	describe("parseDreamCommand", () => {
		it("parses /dream as run command", () => {
			expect(parseDreamCommand("/dream")).toEqual({ type: "run" });
		});

		it("parses /dream backup as showBackup", () => {
			expect(parseDreamCommand("/dream backup")).toEqual({ type: "showBackup" });
		});

		it("parses /dream backup /path as setBackup", () => {
			expect(parseDreamCommand("/dream backup /some/path")).toEqual({ type: "setBackup", path: "/some/path" });
		});

		it("parses /dream backup ~/path with tilde", () => {
			expect(parseDreamCommand("/dream backup ~/backups")).toEqual({ type: "setBackup", path: "~/backups" });
		});

		it("trims whitespace", () => {
			expect(parseDreamCommand("/dream  ")).toEqual({ type: "run" });
			expect(parseDreamCommand("/dream  backup  ")).toEqual({ type: "showBackup" });
		});
	});

	describe("validateArchivePath", () => {
		it("accepts valid absolute path", () => {
			expect(() => validateArchivePath("/tmp/archive", ["/home/user/.dreb/memory"])).not.toThrow();
		});

		it("rejects empty path", () => {
			expect(() => validateArchivePath("", ["/home/user/.dreb/memory"])).toThrow();
		});

		it("rejects relative path", () => {
			expect(() => validateArchivePath("relative/path", ["/home/user/.dreb/memory"])).toThrow();
		});

		it("rejects path that is child of memory dir", () => {
			expect(() => validateArchivePath("/home/user/.dreb/memory/archive", ["/home/user/.dreb/memory"])).toThrow();
		});

		it("rejects path where memory dir is child of archive", () => {
			expect(() => validateArchivePath("/home/user/.dreb", ["/home/user/.dreb/memory"])).toThrow();
		});
	});

	describe("validateMemoryLinks", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("returns valid when all links exist", () => {
			writeFileSync(join(tempDir, "entry.md"), "---\nname: test\n---\nContent");
			writeFileSync(join(tempDir, "MEMORY.md"), "- [Test](entry.md) — test entry\n");
			const result = validateMemoryLinks([tempDir]);
			expect(result.valid).toBe(true);
			expect(result.brokenLinks).toHaveLength(0);
		});

		it("detects broken links", () => {
			writeFileSync(join(tempDir, "MEMORY.md"), "- [Missing](missing.md) — gone\n");
			const result = validateMemoryLinks([tempDir]);
			expect(result.valid).toBe(false);
			expect(result.brokenLinks).toHaveLength(1);
			expect(result.brokenLinks[0].target).toBe("missing.md");
		});

		it("handles missing MEMORY.md gracefully", () => {
			const result = validateMemoryLinks([tempDir]);
			expect(result.valid).toBe(true);
		});

		it("handles non-existent directory gracefully", () => {
			const result = validateMemoryLinks(["/nonexistent/path"]);
			expect(result.valid).toBe(true);
		});
	});

	describe("performDreamBackup", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-backup-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("creates backup with correct structure", async () => {
			const memDir = join(tempDir, "memory");
			const archiveDir = join(tempDir, "archive");
			mkdirSync(memDir, { recursive: true });
			writeFileSync(join(memDir, "MEMORY.md"), "# Memory");
			writeFileSync(join(memDir, "entry.md"), "content");

			const context: DreamContext = {
				archivePath: archiveDir,
				lastRunTimestamp: null,
				globalMemoryDir: memDir,
				projectMemoryDirs: [],
				claudeMemoryDirs: [],
				sessionsDir: join(tempDir, "sessions"),
			};

			const result = await performDreamBackup(context);
			expect(result.verified).toBe(true);
			expect(result.fileCount).toBe(2);
			expect(existsSync(result.backupDir)).toBe(true);
		});

		it("copies project memory dirs", async () => {
			const globalDir = join(tempDir, "global");
			const projectDir = join(tempDir, "project", ".dreb", "memory");
			const archiveDir = join(tempDir, "archive");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "MEMORY.md"), "# Global");
			writeFileSync(join(projectDir, "MEMORY.md"), "# Project");

			const context: DreamContext = {
				archivePath: archiveDir,
				lastRunTimestamp: null,
				globalMemoryDir: globalDir,
				projectMemoryDirs: [projectDir],
				claudeMemoryDirs: [],
				sessionsDir: join(tempDir, "sessions"),
			};

			const result = await performDreamBackup(context);
			expect(result.verified).toBe(true);
			expect(result.fileCount).toBe(2);
		});

		it("handles missing source dirs gracefully", async () => {
			const archiveDir = join(tempDir, "archive");
			const context: DreamContext = {
				archivePath: archiveDir,
				lastRunTimestamp: null,
				globalMemoryDir: join(tempDir, "nonexistent"),
				projectMemoryDirs: [],
				claudeMemoryDirs: [],
				sessionsDir: join(tempDir, "sessions"),
			};

			const result = await performDreamBackup(context);
			expect(result.fileCount).toBe(0);
			expect(existsSync(result.backupDir)).toBe(true);
		});
	});

	describe("buildDreamPrompt", () => {
		it("includes all pipeline steps", () => {
			const context: DreamContext = {
				archivePath: "/tmp/archive",
				lastRunTimestamp: null,
				globalMemoryDir: "/home/user/.dreb/memory",
				projectMemoryDirs: ["/home/user/project/.dreb/memory"],
				claudeMemoryDirs: [],
				sessionsDir: "/home/user/.dreb/agent/sessions",
			};
			const backup: BackupResult = {
				backupDir: "/tmp/archive/dream-backup-2026-04-15",
				timestamp: "2026-04-15T13-29-13-106Z",
				fileCount: 5,
				totalSize: 1024,
				verified: true,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain("Step 1");
			expect(prompt).toContain("Step 10");
			expect(prompt).toContain("read-only");
			expect(prompt).toContain("STOP AND WAIT");
			expect(prompt).toContain(".dream-last-run");
			expect(prompt).toContain(context.globalMemoryDir);
			expect(prompt).toContain("Never (first run)");
		});

		it("includes last run timestamp when provided", () => {
			const context: DreamContext = {
				archivePath: "/tmp/archive",
				lastRunTimestamp: "2026-04-10T12:00:00.000Z",
				globalMemoryDir: "/home/user/.dreb/memory",
				projectMemoryDirs: [],
				claudeMemoryDirs: [],
				sessionsDir: "/home/user/.dreb/agent/sessions",
			};
			const backup: BackupResult = {
				backupDir: "/tmp/archive/dream-backup-2026-04-15",
				timestamp: "2026-04-15T00-00-00-000Z",
				fileCount: 3,
				totalSize: 512,
				verified: true,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain("2026-04-10T12:00:00.000Z");
			expect(prompt).not.toContain("Never (first run)");
		});

		it("marks claude dirs as read-only", () => {
			const context: DreamContext = {
				archivePath: "/tmp/archive",
				lastRunTimestamp: null,
				globalMemoryDir: "/home/user/.dreb/memory",
				projectMemoryDirs: [],
				claudeMemoryDirs: ["/home/user/.claude/projects/memory"],
				sessionsDir: "/home/user/.dreb/agent/sessions",
			};
			const backup: BackupResult = {
				backupDir: "/tmp/archive/dream-backup-2026-04-15",
				timestamp: "2026-04-15T00-00-00-000Z",
				fileCount: 1,
				totalSize: 256,
				verified: true,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain(".claude/");
			expect(prompt).toContain("READ-ONLY");
		});
	});

	describe("acquireDreamLock", () => {
		it("acquires and releases lock", async () => {
			const release = await acquireDreamLock();
			expect(typeof release).toBe("function");
			release();
		});

		it("prevents concurrent acquisition", async () => {
			const release = await acquireDreamLock();
			try {
				await expect(acquireDreamLock()).rejects.toThrow();
			} finally {
				release();
			}
		});
	});

	describe("pruneOldBackups", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-prune-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("keeps last N backups and removes older ones", async () => {
			for (let i = 1; i <= 5; i++) {
				const dir = join(tempDir, `dream-backup-2026-04-${String(i).padStart(2, "0")}T00-00-00-000Z_abc`);
				mkdirSync(dir);
			}

			await pruneOldBackups(tempDir, 3);

			const remaining = readdirSync(tempDir);
			expect(remaining).toHaveLength(3);
			expect(remaining).toContain("dream-backup-2026-04-05T00-00-00-000Z_abc");
			expect(remaining).toContain("dream-backup-2026-04-04T00-00-00-000Z_abc");
			expect(remaining).toContain("dream-backup-2026-04-03T00-00-00-000Z_abc");
		});

		it("handles fewer than keepCount backups", async () => {
			mkdirSync(join(tempDir, "dream-backup-2026-04-01T00-00-00-000Z_abc"));
			await pruneOldBackups(tempDir, 10);
			expect(readdirSync(tempDir)).toHaveLength(1);
		});

		it("handles empty archive dir", async () => {
			await pruneOldBackups(tempDir, 10);
			expect(readdirSync(tempDir)).toHaveLength(0);
		});

		it("handles non-existent archive dir", async () => {
			await expect(pruneOldBackups(join(tempDir, "nonexistent"), 10)).resolves.not.toThrow();
		});
	});

	describe("cleanupDreamTmpDirs", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-cleanup-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("removes .dream-tmp directories", () => {
			const tmpDreamDir = join(tempDir, ".dream-tmp");
			mkdirSync(tmpDreamDir);
			writeFileSync(join(tmpDreamDir, "temp.md"), "temp");

			cleanupDreamTmpDirs([tempDir]);
			expect(existsSync(tmpDreamDir)).toBe(false);
		});

		it("handles missing .dream-tmp gracefully", () => {
			expect(() => cleanupDreamTmpDirs([tempDir])).not.toThrow();
		});

		it("handles non-existent dirs gracefully", () => {
			expect(() => cleanupDreamTmpDirs(["/nonexistent/path"])).not.toThrow();
		});
	});

	describe("discoverAllProjectMemoryDirs", () => {
		it("returns an array", () => {
			const result = discoverAllProjectMemoryDirs();
			expect(Array.isArray(result)).toBe(true);
		});
	});
});
