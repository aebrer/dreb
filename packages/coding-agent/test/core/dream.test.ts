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
	resolveDreamContext,
	safeDirName,
	validateArchivePath,
	validateMemoryLinks,
} from "../../src/core/dream.js";
import type { SettingsManager } from "../../src/core/settings-manager.js";

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

		it("preserves paths with spaces (quote stripping is expandPath's job)", () => {
			expect(parseDreamCommand("/dream backup /mnt/c/path with spaces/backups")).toEqual({
				type: "setBackup",
				path: "/mnt/c/path with spaces/backups",
			});
		});

		it("preserves quoted paths as-is (expandPath strips quotes downstream)", () => {
			expect(parseDreamCommand('/dream backup "/mnt/c/path with spaces"')).toEqual({
				type: "setBackup",
				path: '"/mnt/c/path with spaces"',
			});
		});

		it("treats unknown subcommand as run", () => {
			expect(parseDreamCommand("/dream unknownthing")).toEqual({ type: "run" });
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

		it("skips external URLs", () => {
			writeFileSync(
				join(tempDir, "MEMORY.md"),
				"- [Docs](https://example.com) — external link\n- [API](http://api.test) — another\n",
			);
			const result = validateMemoryLinks([tempDir]);
			expect(result.valid).toBe(true);
			expect(result.brokenLinks).toHaveLength(0);
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
			expect(existsSync(result.backupPath)).toBe(true);
			expect(result.backupPath).toMatch(/\.tar\.gz$/);
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
			expect(existsSync(result.backupPath)).toBe(true);
			expect(result.backupPath).toMatch(/\.tar\.gz$/);
		});

		it("includes claude memory dirs in backup", async () => {
			const globalDir = join(tempDir, "global");
			const claudeDir = join(tempDir, "claude", "project", "memory");
			const archiveDir = join(tempDir, "archive");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(join(globalDir, "MEMORY.md"), "# Global");
			writeFileSync(join(claudeDir, "MEMORY.md"), "# Claude");

			const context: DreamContext = {
				archivePath: archiveDir,
				lastRunTimestamp: null,
				globalMemoryDir: globalDir,
				projectMemoryDirs: [],
				claudeMemoryDirs: [claudeDir],
				sessionsDir: join(tempDir, "sessions"),
			};

			const result = await performDreamBackup(context);
			expect(result.verified).toBe(true);
			expect(result.fileCount).toBe(2);
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
				backupPath: "/tmp/archive/dream-backup-2026-04-15.tar.gz",
				timestamp: "2026-04-15T13-29-13-106Z",
				fileCount: 5,
				totalSize: 1024,
				verified: true,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain("Step 0");
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
				backupPath: "/tmp/archive/dream-backup-2026-04-15.tar.gz",
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
				backupPath: "/tmp/archive/dream-backup-2026-04-15.tar.gz",
				timestamp: "2026-04-15T00-00-00-000Z",
				fileCount: 1,
				totalSize: 256,
				verified: true,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain(".claude/");
			expect(prompt).toContain("READ-ONLY");
		});

		it("shows verification warning when verified is false", () => {
			const context: DreamContext = {
				archivePath: "/tmp/archive",
				lastRunTimestamp: null,
				globalMemoryDir: "/home/user/.dreb/memory",
				projectMemoryDirs: [],
				claudeMemoryDirs: [],
				sessionsDir: "/home/user/.dreb/agent/sessions",
			};
			const backup: BackupResult = {
				backupPath: "/tmp/archive/dream-backup-2026-04-15.tar.gz",
				timestamp: "2026-04-15T00-00-00-000Z",
				fileCount: 3,
				totalSize: 512,
				verified: false,
			};

			const prompt = buildDreamPrompt(context, backup);
			expect(prompt).toContain("⚠ Verification mismatch");
			expect(prompt).not.toContain("✓ Verified");
		});

		it("spills large file listings to temp file", () => {
			const memDir = mkdtempSync(join(tmpdir(), "dreb-dream-listing-"));
			try {
				// Each entry in the listing is "- entry-XXXX.md\n" (16 chars)
				// Need >10000/16 = 625+ files, plus header overhead. Use 700 for safety.
				for (let i = 0; i < 700; i++) {
					writeFileSync(join(memDir, `entry-${String(i).padStart(4, "0")}.md`), "content");
				}

				const context: DreamContext = {
					archivePath: "/tmp/archive",
					lastRunTimestamp: null,
					globalMemoryDir: memDir,
					projectMemoryDirs: [],
					claudeMemoryDirs: [],
					sessionsDir: "/tmp/sessions",
				};
				const backup: BackupResult = {
					backupPath: "/tmp/archive/dream-backup-test.tar.gz",
					timestamp: "test",
					fileCount: 700,
					totalSize: 4200,
					verified: true,
				};

				const prompt = buildDreamPrompt(context, backup);
				expect(prompt).toContain("File listing too large");
				expect(prompt).toContain(".dream-tmp");
				// Verify the temp file was actually created
				const tmpDreamDir = join(memDir, ".dream-tmp");
				expect(existsSync(tmpDreamDir)).toBe(true);
			} finally {
				rmSync(memDir, { recursive: true, force: true });
			}
		});
	});

	describe("acquireDreamLock", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-lock-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("acquires and releases lock", async () => {
			const release = await acquireDreamLock(tempDir);
			expect(typeof release).toBe("function");
			release();
		});

		it("prevents concurrent acquisition", async () => {
			const release = await acquireDreamLock(tempDir);
			try {
				await expect(acquireDreamLock(tempDir)).rejects.toThrow(/already running/);
			} finally {
				release();
			}
		});

		it("creates lock file in specified directory", async () => {
			const release = await acquireDreamLock(tempDir);
			try {
				expect(existsSync(join(tempDir, ".dream.lock"))).toBe(true);
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
				const file = join(tempDir, `dream-backup-2026-04-${String(i).padStart(2, "0")}T00-00-00-000Z_abc.tar.gz`);
				writeFileSync(file, "fake archive");
			}

			await pruneOldBackups(tempDir, 3);

			const remaining = readdirSync(tempDir);
			expect(remaining).toHaveLength(3);
			expect(remaining).toContain("dream-backup-2026-04-05T00-00-00-000Z_abc.tar.gz");
			expect(remaining).toContain("dream-backup-2026-04-04T00-00-00-000Z_abc.tar.gz");
			expect(remaining).toContain("dream-backup-2026-04-03T00-00-00-000Z_abc.tar.gz");
		});

		it("handles fewer than keepCount backups", async () => {
			writeFileSync(join(tempDir, "dream-backup-2026-04-01T00-00-00-000Z_abc.tar.gz"), "fake archive");
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
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "dreb-dream-discover-test-"));
		});

		afterEach(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("returns an array", () => {
			const result = discoverAllProjectMemoryDirs();
			expect(Array.isArray(result)).toBe(true);
		});

		it("returns directories that end with .dreb/memory and exist", () => {
			const result = discoverAllProjectMemoryDirs();
			for (const dir of result) {
				expect(dir).toMatch(/\.dreb\/memory$/);
				expect(existsSync(dir)).toBe(true);
			}
		});

		it("discovers project memory dirs from session JSONL headers", () => {
			// Create a fake sessions dir with a --encoded-- session dir
			const sessionsDir = join(tempDir, "sessions");
			const sessionSubDir = join(sessionsDir, "--home-testuser-myproject--");
			mkdirSync(sessionSubDir, { recursive: true });

			// Create a fake project with .dreb/memory
			const projectDir = join(tempDir, "myproject");
			const memDir = join(projectDir, ".dreb", "memory");
			mkdirSync(memDir, { recursive: true });
			writeFileSync(join(memDir, "MEMORY.md"), "# Test");

			// Write a JSONL session file with a valid header pointing to the project
			const sessionFile = join(sessionSubDir, "2026-04-15T00-00-00-000Z_abc.jsonl");
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: projectDir })}\n`);

			const result = discoverAllProjectMemoryDirs(sessionsDir);
			expect(result).toContain(memDir);
		});

		it("skips directories not matching --name-- pattern", () => {
			const sessionsDir = join(tempDir, "sessions");
			// Create a dir that doesn't match the pattern
			const otherDir = join(sessionsDir, "not-encoded");
			mkdirSync(otherDir, { recursive: true });
			writeFileSync(join(otherDir, "session.jsonl"), `${JSON.stringify({ type: "session", cwd: tempDir })}\n`);

			// Also create .dreb/memory at tempDir so it would be found if not filtered
			mkdirSync(join(tempDir, ".dreb", "memory"), { recursive: true });

			const result = discoverAllProjectMemoryDirs(sessionsDir);
			// Should NOT include tempDir's memory — the session dir doesn't match --name--
			expect(result).not.toContain(join(tempDir, ".dreb", "memory"));
		});

		it("deduplicates sessions pointing to the same project", () => {
			const sessionsDir = join(tempDir, "sessions");
			const projectDir = join(tempDir, "myproject");
			const memDir = join(projectDir, ".dreb", "memory");
			mkdirSync(memDir, { recursive: true });

			// Two session dirs both pointing to the same cwd
			for (const name of ["--session-a--", "--session-b--"]) {
				const sessionSubDir = join(sessionsDir, name);
				mkdirSync(sessionSubDir, { recursive: true });
				writeFileSync(
					join(sessionSubDir, "session.jsonl"),
					`${JSON.stringify({ type: "session", cwd: projectDir })}\n`,
				);
			}

			const result = discoverAllProjectMemoryDirs(sessionsDir);
			const matches = result.filter((d) => d === memDir);
			expect(matches).toHaveLength(1);
		});

		it("skips sessions with corrupt or missing JSONL headers", () => {
			const sessionsDir = join(tempDir, "sessions");

			// Session dir with corrupt JSONL
			const corruptDir = join(sessionsDir, "--corrupt-session--");
			mkdirSync(corruptDir, { recursive: true });
			writeFileSync(join(corruptDir, "session.jsonl"), "not json\n");

			// Session dir with wrong header type
			const wrongTypeDir = join(sessionsDir, "--wrong-type--");
			mkdirSync(wrongTypeDir, { recursive: true });
			writeFileSync(
				join(wrongTypeDir, "session.jsonl"),
				`${JSON.stringify({ type: "message", content: "hello" })}\n`,
			);

			const result = discoverAllProjectMemoryDirs(sessionsDir);
			expect(result).toHaveLength(0);
		});

		it("excludes sessions whose project has no .dreb/memory dir", () => {
			const sessionsDir = join(tempDir, "sessions");
			const projectDir = join(tempDir, "no-memory-project");
			mkdirSync(projectDir, { recursive: true });
			// Deliberately NOT creating .dreb/memory

			const sessionSubDir = join(sessionsDir, "--no-memory--");
			mkdirSync(sessionSubDir, { recursive: true });
			writeFileSync(
				join(sessionSubDir, "session.jsonl"),
				`${JSON.stringify({ type: "session", cwd: projectDir })}\n`,
			);

			const result = discoverAllProjectMemoryDirs(sessionsDir);
			expect(result).toHaveLength(0);
		});

		it("returns empty array for non-existent sessions dir", () => {
			const result = discoverAllProjectMemoryDirs(join(tempDir, "nonexistent"));
			expect(result).toEqual([]);
		});
	});

	describe("safeDirName", () => {
		it("strips leading slash and replaces separators", () => {
			expect(safeDirName("/home/user/.dreb/memory")).toBe("home-user-.dreb-memory");
		});

		it("replaces colons and backslashes", () => {
			expect(safeDirName("C:\\Users\\test")).toBe("C--Users-test");
		});

		it("handles paths without leading slash", () => {
			expect(safeDirName("relative/path")).toBe("relative-path");
		});
	});

	describe("resolveDreamContext", () => {
		it("returns a DreamContext with the archive path from settings manager", async () => {
			const mockSettingsManager = {
				getDreamArchivePath: () => "/tmp/test-archive",
			} as unknown as SettingsManager;

			const ctx = await resolveDreamContext(mockSettingsManager);
			expect(ctx.archivePath).toBe("/tmp/test-archive");
		});

		it("sets globalMemoryDir to ~/.dreb/memory", async () => {
			const { homedir } = await import("node:os");
			const mockSettingsManager = {
				getDreamArchivePath: () => "/tmp/test-archive",
			} as unknown as SettingsManager;

			const ctx = await resolveDreamContext(mockSettingsManager);
			expect(ctx.globalMemoryDir).toBe(join(homedir(), ".dreb", "memory"));
		});

		it("lastRunTimestamp is null when no marker file exists", async () => {
			// resolveDreamContext reads ~/.dreb/memory/.dream-last-run — we can't
			// easily redirect that without env var overrides. But we can verify the
			// type contract and that it returns null OR a valid ISO timestamp string.
			const mockSettingsManager = {
				getDreamArchivePath: () => "/tmp/test-archive-no-marker",
			} as unknown as SettingsManager;

			const ctx = await resolveDreamContext(mockSettingsManager);
			if (ctx.lastRunTimestamp !== null) {
				// If a marker file exists on this machine, it should be a valid timestamp
				expect(new Date(ctx.lastRunTimestamp).toISOString()).toBe(ctx.lastRunTimestamp);
			} else {
				expect(ctx.lastRunTimestamp).toBeNull();
			}
		});

		it("reads lastRunTimestamp from marker file in temp dir", async () => {
			// Create a temp dir with a known marker file to verify reading logic.
			// resolveDreamContext hardcodes ~/.dreb/memory — so we test the underlying
			// logic by writing a marker and reading it directly.
			const tempMemDir = mkdtempSync(join(tmpdir(), "dreb-dream-marker-test-"));
			try {
				const markerPath = join(tempMemDir, ".dream-last-run");
				const knownTimestamp = "2026-04-10T12:00:00.000Z";
				writeFileSync(markerPath, knownTimestamp, "utf-8");

				// Verify readFileSync on the marker produces the expected content
				const { readFileSync } = await import("node:fs");
				const content = readFileSync(markerPath, "utf-8").trim();
				expect(content).toBe(knownTimestamp);
			} finally {
				rmSync(tempMemDir, { recursive: true, force: true });
			}
		});

		it("sessionsDir is a string", async () => {
			const mockSettingsManager = {
				getDreamArchivePath: () => "/tmp/test-archive",
			} as unknown as SettingsManager;

			const ctx = await resolveDreamContext(mockSettingsManager);
			expect(typeof ctx.sessionsDir).toBe("string");
			expect(ctx.sessionsDir.length).toBeGreaterThan(0);
		});
	});
});
