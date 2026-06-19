import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectNestedContext,
	computeNestedContextBlock,
	formatNestedContextBlock,
	type NestedContextState,
	parseLeadingCd,
	resolveTargetDir,
} from "../src/core/nested-context.js";

const itIfFilePermissionsApply =
	process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) ? it.skip : it;
const itIfSymlinksApply = canCreateSymlink() ? it : it.skip;

describe("parseLeadingCd", () => {
	it("extracts an absolute path target", () => {
		expect(parseLeadingCd("cd /home/user/project && grep foo")).toBe("/home/user/project");
	});

	it("extracts a relative path target", () => {
		expect(parseLeadingCd("cd sub/dir && ls")).toBe("sub/dir");
	});

	it("preserves a leading ~ (expansion happens later)", () => {
		expect(parseLeadingCd("cd ~/work/repo && npm test")).toBe("~/work/repo");
	});

	it("handles a double-quoted path with spaces", () => {
		expect(parseLeadingCd('cd "/home/My Project" && ls')).toBe("/home/My Project");
	});

	it("handles a single-quoted path", () => {
		expect(parseLeadingCd("cd '/tmp/a b' && ls")).toBe("/tmp/a b");
	});

	it("returns the first cd target when multiple cds are chained", () => {
		expect(parseLeadingCd("cd /a && cd /b")).toBe("/a");
	});

	it("tolerates leading whitespace", () => {
		expect(parseLeadingCd("   cd /x")).toBe("/x");
	});

	it("returns null when the command does not start with cd", () => {
		expect(parseLeadingCd("grep -r foo /a/b")).toBeNull();
		expect(parseLeadingCd("ls && cd /a")).toBeNull();
	});

	it("returns null for variable-based targets", () => {
		expect(parseLeadingCd("cd $HOME && ls")).toBeNull();
	});

	it("returns null for `cd -`", () => {
		expect(parseLeadingCd("cd -")).toBeNull();
	});

	it("skips cd option flags before extracting the target", () => {
		expect(parseLeadingCd("cd -P /repo/sub")).toBe("/repo/sub");
		expect(parseLeadingCd("cd -L /repo/sub")).toBe("/repo/sub");
		expect(parseLeadingCd("cd -- /repo/sub")).toBe("/repo/sub");
		expect(parseLeadingCd("cd -- -weirddir")).toBe("-weirddir");
		expect(parseLeadingCd("cd -")).toBeNull();
	});

	it("returns null for non-string input", () => {
		expect(parseLeadingCd(undefined as unknown as string)).toBeNull();
	});
});

describe("resolveTargetDir", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = realpathSync(mkdtemp());
		cwd = join(tempDir, "project");
		mkdirSync(join(cwd, "sub"), { recursive: true });
		writeFileSync(join(cwd, "sub", "file.py"), "x = 1\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("maps a read of a file to its parent directory", () => {
		const dir = resolveTargetDir("read", { path: join(cwd, "sub", "file.py") }, cwd);
		expect(dir).toBe(join(cwd, "sub"));
	});

	it("uses an existing directory argument as-is (ls)", () => {
		const dir = resolveTargetDir("ls", { path: join(cwd, "sub") }, cwd);
		expect(dir).toBe(join(cwd, "sub"));
	});

	it("resolves a relative path against cwd", () => {
		const dir = resolveTargetDir("grep", { path: "sub" }, cwd);
		expect(dir).toBe(join(cwd, "sub"));
	});

	it("maps a write to a not-yet-existing file to its parent directory", () => {
		const dir = resolveTargetDir("write", { path: join(cwd, "sub", "new.py") }, cwd);
		expect(dir).toBe(join(cwd, "sub"));
	});

	it("resolves bash cd targets", () => {
		const dir = resolveTargetDir("bash", { command: `cd ${join(cwd, "sub")} && ls` }, cwd);
		expect(dir).toBe(join(cwd, "sub"));
	});

	it("expands tilde in bash cd targets and path-tool arguments", () => {
		expect(resolveTargetDir("bash", { command: "cd ~ && pwd" }, cwd)).toBe(homedir());
		expect(resolveTargetDir("ls", { path: "~" }, cwd)).toBe(homedir());

		const missingHomeChild = `__dreb_missing_nested_context_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		expect(resolveTargetDir("bash", { command: `cd ~/${missingHomeChild} && pwd` }, cwd)).toBe(homedir());
	});

	it("returns null for bash without a leading cd", () => {
		expect(resolveTargetDir("bash", { command: "ls -la" }, cwd)).toBeNull();
	});

	it("returns null for tools without a path argument", () => {
		expect(resolveTargetDir("read", {}, cwd)).toBeNull();
		expect(resolveTargetDir("tasks_update", { tasks: [] }, cwd)).toBeNull();
		expect(resolveTargetDir("read", undefined, cwd)).toBeNull();
	});
});

describe("collectNestedContext", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = realpathSync(mkdtemp());
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function mkContext(dir: string, name: string, content: string) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), content);
	}

	it("loads intermediate nested files within the cwd subtree, ordered outermost-first", () => {
		const cwd = join(tempDir, "project");
		const a = join(cwd, "a");
		const b = join(a, "b");
		mkContext(cwd, "CLAUDE.md", "# root");
		mkContext(a, "CLAUDE.md", "# a");
		mkContext(b, "AGENTS.md", "# b");

		// Seed with the cwd-level file as already loaded (mirrors session start).
		const loaded = new Set<string>([realpathSync(join(cwd, "CLAUDE.md"))]);
		const result = collectNestedContext(b, cwd, loaded);

		const paths = result.files.map((r) => r.path);
		expect(paths).toEqual([join(a, "CLAUDE.md"), join(b, "AGENTS.md")]);
		// Root file was already loaded → not re-injected.
		expect(paths).not.toContain(join(cwd, "CLAUDE.md"));
	});

	it("never walks above cwd for in-subtree targets", () => {
		const outer = join(tempDir, "outer");
		const cwd = join(outer, "project");
		const sub = join(cwd, "sub");
		mkContext(outer, "CLAUDE.md", "# outer (must not load)");
		mkContext(sub, "CLAUDE.md", "# sub");

		const result = collectNestedContext(sub, cwd, new Set());
		const paths = result.files.map((r) => r.path);
		expect(paths).toContain(join(sub, "CLAUDE.md"));
		expect(paths).not.toContain(join(outer, "CLAUDE.md"));
	});

	it("stops at the outermost git repo root for targets outside cwd", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });

		const repo = join(tempDir, "other", "repo");
		const subA = join(repo, "sub");
		const deep = join(subA, "deep");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkContext(join(tempDir, "other"), "CLAUDE.md", "# above git root (must not load)");
		mkContext(repo, "CLAUDE.md", "# repo root");
		mkContext(subA, "AGENTS.md", "# sub");
		mkdirSync(deep, { recursive: true });

		const result = collectNestedContext(deep, cwd, new Set());
		const paths = result.files.map((r) => r.path);
		expect(paths).toContain(join(repo, "CLAUDE.md"));
		expect(paths).toContain(join(subA, "AGENTS.md"));
		expect(paths).not.toContain(join(tempDir, "other", "CLAUDE.md"));
	});

	it("uses the outermost git repo root as the outside-cwd ceiling when git roots are nested", () => {
		const cwd = join(tempDir, "session");
		mkdirSync(cwd, { recursive: true });

		const workspace = join(tempDir, "workspace");
		const outerRepo = join(workspace, "outer-repo");
		const innerRepo = join(outerRepo, "packages", "inner-repo");
		const target = join(innerRepo, "src", "deep");
		mkdirSync(join(outerRepo, ".git"), { recursive: true });
		mkdirSync(join(innerRepo, ".git"), { recursive: true });
		mkContext(workspace, "CLAUDE.md", "# above outer repo (must not load)");
		mkContext(outerRepo, "CLAUDE.md", "# outer repo");
		mkContext(innerRepo, "AGENTS.md", "# inner repo");
		mkContext(target, "CLAUDE.md", "# target dir");

		const result = collectNestedContext(target, cwd, new Set());
		const paths = result.files.map((r) => r.path);
		expect(paths).toEqual([join(outerRepo, "CLAUDE.md"), join(innerRepo, "AGENTS.md"), join(target, "CLAUDE.md")]);
		expect(paths).not.toContain(join(workspace, "CLAUDE.md"));
	});

	it("stops at the outermost context file when no git root exists (outside cwd)", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });

		const top = join(tempDir, "loose");
		const mid = join(top, "mid");
		const leaf = join(mid, "leaf");
		mkContext(top, "CLAUDE.md", "# top");
		mkContext(leaf, "CLAUDE.md", "# leaf");
		mkdirSync(leaf, { recursive: true });

		const result = collectNestedContext(leaf, cwd, new Set());
		const paths = result.files.map((r) => r.path);
		expect(paths).toContain(join(top, "CLAUDE.md"));
		expect(paths).toContain(join(leaf, "CLAUDE.md"));
		// `mid` has no context file — fine; nothing above `top` should be visited.
		expect(paths.every((p) => p.startsWith(top + sep) || p === join(top, "CLAUDE.md"))).toBe(true);
	});

	it("dedupes by realpath and never injects the same file twice", () => {
		const cwd = join(tempDir, "project");
		const sub = join(cwd, "sub");
		mkContext(sub, "CLAUDE.md", "# sub");

		const loaded = new Set<string>();
		const first = collectNestedContext(sub, cwd, loaded);
		expect(first.files.map((r) => r.path)).toContain(join(sub, "CLAUDE.md"));

		// Same set, second call: everything already loaded → empty.
		const second = collectNestedContext(sub, cwd, loaded);
		expect(second.files).toEqual([]);
		expect(second.hadReadError).toBe(false);
	});

	itIfSymlinksApply("dedupes the same context file reached through real and symlinked paths", () => {
		const cwd = join(tempDir, "project");
		const realSub = join(cwd, "real-sub");
		const linkedSub = join(cwd, "linked-sub");
		mkContext(realSub, "CLAUDE.md", "# symlinked context");
		symlinkSync(realSub, linkedSub, "dir");

		const loaded = new Set<string>();
		const viaSymlink = collectNestedContext(linkedSub, cwd, loaded);
		const viaRealPath = collectNestedContext(realSub, cwd, loaded);

		expect(viaSymlink.files).toHaveLength(1);
		expect(viaSymlink.files[0].path).toBe(join(linkedSub, "CLAUDE.md"));
		expect(realpathSync(viaSymlink.files[0].path)).toBe(realpathSync(join(realSub, "CLAUDE.md")));
		expect(viaRealPath.files).toEqual([]);
		expect(loaded.has(realpathSync(join(realSub, "CLAUDE.md")))).toBe(true);
	});

	it("strips HTML comments from loaded content", () => {
		const cwd = join(tempDir, "project");
		const sub = join(cwd, "sub");
		mkContext(sub, "CLAUDE.md", "# title\n<!-- secret comment -->\nvisible");
		const result = collectNestedContext(sub, cwd, new Set());
		expect(result.files[0].content).not.toContain("secret comment");
		expect(result.files[0].content).toContain("visible");
	});

	it("returns empty when the directory has no context files", () => {
		const cwd = join(tempDir, "project");
		const sub = join(cwd, "sub");
		mkdirSync(sub, { recursive: true });
		expect(collectNestedContext(sub, cwd, new Set())).toEqual({ files: [], hadReadError: false });
	});
});

describe("formatNestedContextBlock", () => {
	it("leads with why it happened and headers each file with its source path", () => {
		const block = formatNestedContextBlock("/x/sub", [{ path: "/x/sub/CLAUDE.md", content: "# hello" }]);
		expect(block).toContain("Auto-loaded project context");
		expect(block).toContain("multiple repos / projects / folders");
		expect(block).toContain("context.autoLoadNested");
		expect(block).toContain("BEGIN project context: /x/sub/CLAUDE.md");
		expect(block).toContain("END project context: /x/sub/CLAUDE.md");
		expect(block).toContain("# hello");
	});
});

describe("computeNestedContextBlock (orchestration)", () => {
	let tempDir: string;
	let cwd: string;
	let sub: string;

	beforeEach(() => {
		tempDir = realpathSync(mkdtemp());
		cwd = join(tempDir, "project");
		sub = join(cwd, "sub");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "CLAUDE.md"), "# sub context");
		writeFileSync(join(sub, "file.py"), "x = 1\n");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function freshState(enabled = true): NestedContextState {
		return { enabled, cwd, loaded: new Set(), scannedDirs: new Set() };
	}

	it("returns null when disabled", () => {
		const block = computeNestedContextBlock("read", { path: join(sub, "file.py") }, freshState(false));
		expect(block).toBeNull();
	});

	it("injects the nested context on first touch", () => {
		const block = computeNestedContextBlock("read", { path: join(sub, "file.py") }, freshState());
		expect(block).toContain("# sub context");
		expect(block).toContain("BEGIN project context");
	});

	it("does not re-scan a directory already visited (negative cache)", () => {
		const state = freshState();
		const first = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
		expect(first).not.toBeNull();
		// Second tool touching the same directory → negative cache short-circuits.
		const second = computeNestedContextBlock("ls", { path: sub }, state);
		expect(second).toBeNull();
	});

	itIfFilePermissionsApply("does not negatively cache a directory when an existing context file fails to read", () => {
		const contextPath = join(sub, "CLAUDE.md");
		const state = freshState();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			chmodSync(contextPath, 0o000);
			const first = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
			expect(first).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
			expect(state.scannedDirs.has(realpathSync(sub))).toBe(false);

			chmodSync(contextPath, 0o644);
			writeFileSync(contextPath, "# retried context");
			const second = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
			expect(second).toContain("# retried context");
			expect(state.scannedDirs.has(realpathSync(sub))).toBe(true);
		} finally {
			try {
				chmodSync(contextPath, 0o644);
			} catch {
				// Best-effort cleanup; the temp dir removal below is also forceful.
			}
			warnSpy.mockRestore();
		}
	});

	it("negatively caches a genuinely empty directory", () => {
		rmSync(join(sub, "CLAUDE.md"), { force: true });
		const state = freshState();

		const first = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
		expect(first).toBeNull();
		expect(state.scannedDirs.has(realpathSync(sub))).toBe(true);

		writeFileSync(join(sub, "CLAUDE.md"), "# too late");
		const second = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
		expect(second).toBeNull();
	});

	it("does not re-inject a file already loaded at session start", () => {
		const state = freshState();
		// Seed as if the sub/CLAUDE.md was already loaded at session start.
		state.loaded.add(realpathSync(join(sub, "CLAUDE.md")));
		const block = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
		expect(block).toBeNull();
	});

	it("returns null for tool calls that do not resolve to a directory", () => {
		expect(computeNestedContextBlock("bash", { command: "ls -la" }, freshState())).toBeNull();
		expect(computeNestedContextBlock("tasks_update", { tasks: [] }, freshState())).toBeNull();
	});
});

function canCreateSymlink(): boolean {
	const dir = join(tmpdir(), `nested-ctx-symlink-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		const target = join(dir, "target");
		const link = join(dir, "link");
		mkdirSync(target, { recursive: true });
		symlinkSync(target, link, "dir");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function mkdtemp(): string {
	const dir = join(tmpdir(), `nested-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
