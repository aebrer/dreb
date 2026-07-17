import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsReadSwap = vi.hoisted(() => ({
	candidate: undefined as string | undefined,
	outsideTarget: undefined as string | undefined,
	swapped: false,
}));

// Swap a configured candidate only when resource-loader reads it. This makes the
// pre-read containment check see the in-root target and the read see the outside one.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: vi.fn((...args: any[]) => {
			const filePath = args[0] as string;
			if (filePath === fsReadSwap.candidate && fsReadSwap.outsideTarget) {
				actual.unlinkSync(filePath);
				actual.symlinkSync(fsReadSwap.outsideTarget, filePath, "file");
				fsReadSwap.swapped = true;
			}
			return actual.readFileSync(...(args as Parameters<typeof actual.readFileSync>));
		}),
	};
});

import {
	collectNestedContext,
	computeNestedContextBlock,
	formatNestedContextBlock,
	type NestedContextState,
	parseLeadingCd,
	resolveBashDeliveredFiles,
	resolveSelfReadFile,
	resolveTargetDir,
} from "../src/core/nested-context.js";
import { loadContextFilesFromDir } from "../src/core/resource-loader.js";
import { DEFAULT_MAX_LINES } from "../src/core/tools/truncate.js";

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
		expect(block).toContain("context.trustedFolders");
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
		fsReadSwap.candidate = undefined;
		fsReadSwap.outsideTarget = undefined;
		fsReadSwap.swapped = false;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function freshState(enabled = true, trustedFolders: string[] = []): NestedContextState {
		return {
			policy: { unrestricted: enabled, trustedFolders },
			cwd,
			loaded: new Set(),
			scannedDirs: new Set(),
		};
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

	it("does not duplicate a context file the read tool itself delivers", () => {
		const state = freshState();
		// The first action in `sub` is to read its own CLAUDE.md — the read result already
		// contains it, so the injected block must not duplicate it.
		const block = computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, state);
		expect(block).toBeNull();
		// Still marked loaded (never re-injected) and the dir is still negatively cached.
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
		expect(state.scannedDirs.has(realpathSync(sub))).toBe(true);
	});

	it("still injects an ancestor context file when reading a nested context file", () => {
		// Ancestor (cwd) also has an unloaded context file.
		writeFileSync(join(cwd, "AGENTS.md"), "# root context");
		const state = freshState();
		const block = computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, state);
		// sub/CLAUDE.md is suppressed (read delivers it) but the ancestor is still injected.
		expect(block).not.toBeNull();
		expect(block).toContain("# root context");
		expect(block).not.toContain("# sub context");
		// Both files end up marked loaded.
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
		expect(state.loaded.has(realpathSync(join(cwd, "AGENTS.md")))).toBe(true);
	});

	it("does not duplicate a context file a bash command prints", () => {
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, state);
		expect(block).toBeNull();
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
		expect(state.scannedDirs.has(realpathSync(sub))).toBe(true);
	});

	it("only suppresses the context file a bash command dumps, injecting siblings", () => {
		writeFileSync(join(sub, "AGENTS.md"), "# sub agents");
		const state = freshState();
		// Command dumps AGENTS.md only — CLAUDE.md must still be injected.
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat AGENTS.md` }, state);
		expect(block).not.toBeNull();
		expect(block).toContain("# sub context");
		expect(block).not.toContain("# sub agents");
		expect(state.loaded.has(realpathSync(join(sub, "AGENTS.md")))).toBe(true);
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
	});

	it("still injects when a bash command names a context file with a non-dumping verb", () => {
		// grep/rm/wc/git-add/stat/ls reference the file but do NOT deliver its full content,
		// so the context must still be injected rather than silently suppressed.
		for (const command of [
			`cd ${sub} && grep TODO CLAUDE.md`,
			`cd ${sub} && rm CLAUDE.md`,
			`cd ${sub} && wc -l CLAUDE.md`,
			`cd ${sub} && git add CLAUDE.md`,
			`cd ${sub} && stat CLAUDE.md`,
			`cd ${sub} && ls -la CLAUDE.md`,
		]) {
			const state = freshState();
			const block = computeNestedContextBlock("bash", { command }, state);
			expect(block, command).toContain("# sub context");
		}
	});

	it("still injects when a bash command only partially dumps the file (head/tail)", () => {
		// head/tail/less/more may show only a fragment; suppressing would silently drop the rest.
		for (const verb of ["head", "tail", "head -n 5", "less", "more"]) {
			const state = freshState();
			const block = computeNestedContextBlock("bash", { command: `cd ${sub} && ${verb} CLAUDE.md` }, state);
			expect(block, verb).toContain("# sub context");
		}
	});

	it("still injects when the dumped output is piped or redirected away", () => {
		for (const command of [`cd ${sub} && cat CLAUDE.md | grep TODO`, `cd ${sub} && cat CLAUDE.md > out.txt`]) {
			const state = freshState();
			const block = computeNestedContextBlock("bash", { command }, state);
			expect(block, command).toContain("# sub context");
		}
	});

	it("does not drop a same-named ancestor when a nested context file is dumped", () => {
		// Both cwd and sub have a CLAUDE.md (same basename, different dirs).
		writeFileSync(join(cwd, "CLAUDE.md"), "# root context");
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, state);
		// sub/CLAUDE.md is suppressed (the command dumped it) but the ancestor is still injected.
		expect(block).not.toBeNull();
		expect(block).toContain("# root context");
		expect(block).not.toContain("# sub context");
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
		expect(state.loaded.has(realpathSync(join(cwd, "CLAUDE.md")))).toBe(true);
	});

	it("does not suppress a same-named file dumped from a different directory", () => {
		// Command cds into sub but dumps a CLAUDE.md from an unrelated absolute path.
		const other = join(tempDir, "other");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "CLAUDE.md"), "# other context");
		const state = freshState();
		const block = computeNestedContextBlock(
			"bash",
			{ command: `cd ${sub} && cat ${join(other, "CLAUDE.md")}` },
			state,
		);
		// sub/CLAUDE.md was not the file dumped, so it must still be injected.
		expect(block).toContain("# sub context");
	});

	it("does not suppress the real context file when a derived (.bak) copy is dumped", () => {
		writeFileSync(join(sub, "CLAUDE.md.bak"), "# stale backup");
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md.bak` }, state);
		expect(block).toContain("# sub context");
	});

	it("does not suppress a .dreb/CONTEXT.md when a top-level CONTEXT.md is dumped", () => {
		// The subdir candidate's basename collapses to CONTEXT.md, but it is a different
		// file than `sub/CONTEXT.md`, so dumping the latter must not suppress the former.
		mkdirSync(join(sub, ".dreb"), { recursive: true });
		writeFileSync(join(sub, ".dreb", "CONTEXT.md"), "# dreb context");
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CONTEXT.md` }, state);
		expect(block).toContain("# dreb context");
	});

	it("suppresses a .dreb/CONTEXT.md that is read directly", () => {
		mkdirSync(join(sub, ".dreb"), { recursive: true });
		writeFileSync(join(sub, ".dreb", "CONTEXT.md"), "# dreb context");
		const state = freshState();
		const block = computeNestedContextBlock("read", { path: join(sub, ".dreb", "CONTEXT.md") }, state);
		// The read delivered the .dreb file; it must not be re-injected but the sibling
		// CLAUDE.md the read did not touch must still appear.
		expect(block).not.toContain("# dreb context");
		expect(block).toContain("# sub context");
		expect(state.loaded.has(realpathSync(join(sub, ".dreb", "CONTEXT.md")))).toBe(true);
	});

	it("still injects when a bash command only cds without printing the context file", () => {
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && ls -la` }, state);
		expect(block).toContain("# sub context");
	});

	it("still injects when the read tool targets a non-context file", () => {
		const state = freshState();
		const block = computeNestedContextBlock("read", { path: join(sub, "file.py") }, state);
		expect(block).toContain("# sub context");
	});

	itIfSymlinksApply("suppresses a context file read through a symlinked path", () => {
		const realSub = join(cwd, "real-ctx");
		const linkedSub = join(cwd, "linked-ctx");
		mkdirSync(realSub, { recursive: true });
		writeFileSync(join(realSub, "CLAUDE.md"), "# linked context");
		symlinkSync(realSub, linkedSub, "dir");

		const state = freshState();
		const block = computeNestedContextBlock("read", { path: join(linkedSub, "CLAUDE.md") }, state);
		expect(block).toBeNull();
		expect(state.loaded.has(realpathSync(join(realSub, "CLAUDE.md")))).toBe(true);
	});

	it("still injects when a read is sliced via offset/limit (partial delivery)", () => {
		// A sliced read delivers only a fragment, so the full context file must still inject.
		const state = freshState();
		const block = computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md"), offset: 1, limit: 1 }, state);
		expect(block).toContain("# sub context");
	});

	it("still injects when bat shows only a partial range", () => {
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && bat -r 1:2 CLAUDE.md` }, state);
		expect(block).toContain("# sub context");
	});

	it("still injects when a here-doc merely mentions a context filename", () => {
		// `cat <<EOF ... CLAUDE.md ... EOF` outputs literal text, not the file.
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat <<EOF\nsee CLAUDE.md\nEOF` }, state);
		expect(block).toContain("# sub context");
	});

	it("still injects when the command chains multiple cds (ambiguous cwd)", () => {
		// The cat runs in the final cwd, not the first; resolving against the first would
		// suppress the wrong same-named file, so suppression is skipped entirely.
		writeFileSync(join(cwd, "CLAUDE.md"), "# root context");
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${cwd} && cd sub && cat CLAUDE.md` }, state);
		// targetDir is cwd; cwd/CLAUDE.md must not be suppressed by the ambiguous chained cd.
		expect(block).toContain("# root context");
	});

	it("still injects an oversized context file the tool can only deliver truncated", () => {
		// Beyond the tool's truncation limit the delivered content is incomplete, while the
		// injected block is uncapped — suppressing would silently drop the remainder.
		writeFileSync(join(sub, "CLAUDE.md"), `# sub context\n${"x\n".repeat(2100)}`);
		const readState = freshState();
		expect(computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, readState)).toContain("# sub context");
		const bashState = freshState();
		expect(computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, bashState)).toContain(
			"# sub context",
		);
	});

	it("still injects a context file that is over the byte budget but under the line limit", () => {
		// A few-line file larger than 50KB (one very long line) is delivered truncated by
		// both `read` and `cat`, so the byte-size guard in deliveredInFull must still inject.
		writeFileSync(join(sub, "CLAUDE.md"), `# sub context\n${"x".repeat(60_000)}`);
		const readState = freshState();
		expect(computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, readState)).toContain("# sub context");
		const bashState = freshState();
		expect(computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, bashState)).toContain(
			"# sub context",
		);
	});

	it("still injects when a cat renders past the byte budget via tab expansion", () => {
		// The bash tool delivers truncateTail(renderTerminalOutput(...)), which expands tabs
		// to 8-column stops. A tab-dense file ~7KB on disk renders to ~56KB, so `cat` delivers
		// it truncated even though the raw file is well under budget — measuring the raw file
		// would falsely suppress it (silent drop). `read` delivers the raw content unchanged,
		// so the same file IS fully delivered by read and is correctly suppressed there.
		writeFileSync(join(sub, "CLAUDE.md"), `# sub context\n${"\t".repeat(7000)}X`);
		const bashState = freshState();
		expect(computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, bashState)).toContain(
			"# sub context",
		);
		// read path: raw content is within budget, so it is delivered in full → suppressed.
		const readState = freshState();
		expect(computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, readState)).toBeNull();
		expect(readState.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
	});

	it("suppresses at exactly the line limit but injects one line over it", () => {
		// Pin the deliveredInFull line-count boundary: a file whose split("\n") length is
		// exactly DEFAULT_MAX_LINES is delivered in full (suppress); one line more is
		// truncated by the tool (inject). Guards against a future off-by-one regression.
		// `"line\n".repeat(n)` splits into n + 1 elements (trailing empty), so use n - 1 / n.
		const atLimit = `${"line\n".repeat(DEFAULT_MAX_LINES - 1)}`;
		writeFileSync(join(sub, "CLAUDE.md"), atLimit);
		const atState = freshState();
		expect(computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, atState)).toBeNull();
		expect(atState.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);

		const overLimit = `${"line\n".repeat(DEFAULT_MAX_LINES)}`;
		writeFileSync(join(sub, "CLAUDE.md"), overLimit);
		const overState = freshState();
		const block = computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, overState);
		expect(block).not.toBeNull();
		expect(block).toContain("line");
	});

	it("still injects when a context file is dumped by an uppercase (non-existent) command", () => {
		// `CAT`/`Bat` are command-not-found on Linux (case-sensitive PATH lookup) and emit
		// nothing to stdout, so they must not suppress — the result never contained the file.
		for (const verb of ["CAT", "Cat", "BAT", "Bat"]) {
			const state = freshState();
			const block = computeNestedContextBlock("bash", { command: `cd ${sub} && ${verb} CLAUDE.md` }, state);
			expect(block, verb).toContain("# sub context");
		}
	});

	it("still injects when a bash dump is followed by other output (tail truncation hazard)", () => {
		// `cat CLAUDE.md && npm test` can push the dumped file out of the tail-truncated
		// window, so it must not be suppressed — only a sole single-file dump qualifies.
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md && echo done` }, state);
		expect(block).toContain("# sub context");
	});

	it("still injects when bat shows only a partial range via an attached short flag", () => {
		// `bat -r10:20` (attached value) emits only a range, like `head`/`tail`.
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && bat -r10:20 CLAUDE.md` }, state);
		expect(block).toContain("# sub context");
	});

	it("does not suppress a sibling .claude/CLAUDE.md when a top-level CLAUDE.md is dumped", () => {
		// `.claude/CLAUDE.md`'s basename collapses to CLAUDE.md, but it is a different file
		// than `sub/CLAUDE.md`; full-path matching must keep them distinct.
		mkdirSync(join(sub, ".claude"), { recursive: true });
		writeFileSync(join(sub, ".claude", "CLAUDE.md"), "# claude-dir context");
		const state = freshState();
		const block = computeNestedContextBlock("bash", { command: `cd ${sub} && cat CLAUDE.md` }, state);
		expect(block).toContain("# claude-dir context");
		expect(block).not.toContain("# sub context");
	});

	it("does not re-inject a suppressed context file when a deeper dir is later touched", () => {
		// Exercises the permanent-loaded invariant across a later, deeper-dir call (the
		// negative cache only short-circuits the *same* dir, not a child).
		const deeper = join(sub, "deeper");
		mkdirSync(deeper, { recursive: true });
		writeFileSync(join(deeper, "AGENTS.md"), "# deeper context");
		writeFileSync(join(deeper, "file.py"), "y = 2\n");
		const state = freshState();
		// First: read sub/CLAUDE.md → suppressed (delivered) + marked loaded, sub scanned.
		expect(computeNestedContextBlock("read", { path: join(sub, "CLAUDE.md") }, state)).toBeNull();
		expect(state.loaded.has(realpathSync(join(sub, "CLAUDE.md")))).toBe(true);
		// Later: operate in sub/deeper (not yet scanned). The walk re-passes through sub but
		// must not resurface the already-loaded sub/CLAUDE.md; only deeper's context is new.
		const block = computeNestedContextBlock("read", { path: join(deeper, "file.py") }, state);
		expect(block).toContain("# deeper context");
		expect(block).not.toContain("# sub context");
	});

	it("allows exact and descendant trusted targets but rejects prefix siblings", () => {
		const trusted = join(tempDir, "trusted");
		const child = join(trusted, "child");
		const sibling = join(tempDir, "trusted-sibling");
		mkdirSync(child, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(trusted, "CLAUDE.md"), "# trusted root");
		writeFileSync(join(child, "file.txt"), "x");
		writeFileSync(join(sibling, "CLAUDE.md"), "# sibling");
		writeFileSync(join(sibling, "file.txt"), "x");

		expect(computeNestedContextBlock("ls", { path: trusted }, freshState(false, [trusted]))).toContain(
			"# trusted root",
		);
		expect(
			computeNestedContextBlock("read", { path: join(child, "file.txt") }, freshState(false, [trusted])),
		).toContain("# trusted root");
		const blocked = freshState(false, [trusted]);
		expect(computeNestedContextBlock("read", { path: join(sibling, "file.txt") }, blocked)).toBeNull();
		expect(blocked.scannedDirs).toEqual(new Set());
	});

	it("does not collect context above a narrow trusted root", () => {
		const parent = join(tempDir, "parent");
		const trusted = join(parent, "trusted");
		const child = join(trusted, "child");
		mkdirSync(child, { recursive: true });
		writeFileSync(join(parent, "CLAUDE.md"), "# must not load");
		writeFileSync(join(trusted, "CLAUDE.md"), "# trusted only");
		writeFileSync(join(child, "file.txt"), "x");
		const block = computeNestedContextBlock("read", { path: join(child, "file.txt") }, freshState(false, [trusted]));
		expect(block).toContain("# trusted only");
		expect(block).not.toContain("# must not load");
	});

	itIfSymlinksApply("rejects directory and context-file symlink escapes from a trusted root", () => {
		const trusted = join(tempDir, "trusted");
		const outside = join(tempDir, "outside");
		mkdirSync(trusted, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "CLAUDE.md"), "# escaped");
		writeFileSync(join(outside, "file.txt"), "x");
		symlinkSync(outside, join(trusted, "linked-dir"), "dir");
		symlinkSync(join(outside, "CLAUDE.md"), join(trusted, "AGENTS.md"), "file");
		writeFileSync(join(trusted, "file.txt"), "x");

		expect(
			computeNestedContextBlock(
				"read",
				{ path: join(trusted, "linked-dir", "file.txt") },
				freshState(false, [trusted]),
			),
		).toBeNull();
		const block = computeNestedContextBlock(
			"read",
			{ path: join(trusted, "file.txt") },
			freshState(false, [trusted]),
		);
		expect(block).toBeNull();
	});

	itIfSymlinksApply("rejects a context symlink swapped outside the trusted root during its read", () => {
		const trusted = join(tempDir, "trusted");
		const inside = join(trusted, "inside");
		const outside = join(tempDir, "outside");
		const candidate = join(trusted, "AGENTS.md");
		const insideTarget = join(inside, "AGENTS.md");
		const outsideTarget = join(outside, "AGENTS.md");
		mkdirSync(inside, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(insideTarget, "# trusted context");
		writeFileSync(outsideTarget, "# attacker-controlled context");
		symlinkSync(insideTarget, candidate, "file");

		fsReadSwap.candidate = candidate;
		fsReadSwap.outsideTarget = outsideTarget;
		const files = loadContextFilesFromDir(trusted, undefined, realpathSync(trusted));

		expect(fsReadSwap.swapped).toBe(true);
		expect(files.map((file) => file.content)).not.toContain("# attacker-controlled context");
		expect(files.find((file) => file.path === candidate)).toBeUndefined();
	});

	it("does not cache a blocked target, so a later trusted decision can load it", () => {
		const outside = join(tempDir, "later-trusted");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "CLAUDE.md"), "# newly trusted");
		writeFileSync(join(outside, "file.txt"), "x");
		const state = freshState(false);
		expect(computeNestedContextBlock("read", { path: join(outside, "file.txt") }, state)).toBeNull();
		expect(state.scannedDirs).toEqual(new Set());
		state.policy.trustedFolders = [outside];
		expect(computeNestedContextBlock("read", { path: join(outside, "file.txt") }, state)).toContain(
			"# newly trusted",
		);
	});
});

describe("resolveSelfReadFile", () => {
	it("resolves a relative read path against cwd", () => {
		expect(resolveSelfReadFile("read", { path: "sub/CLAUDE.md" }, "/proj")).toBe("/proj/sub/CLAUDE.md");
	});

	it("returns an absolute read path unchanged", () => {
		expect(resolveSelfReadFile("read", { path: "/a/AGENTS.md" }, "/proj")).toBe("/a/AGENTS.md");
	});

	it("expands a leading ~", () => {
		expect(resolveSelfReadFile("read", { path: "~/x/CLAUDE.md" }, "/proj")).toBe(join(homedir(), "x/CLAUDE.md"));
	});

	it("returns null for non-read tools (they do not echo the full file)", () => {
		expect(resolveSelfReadFile("grep", { path: "/a/CLAUDE.md" }, "/proj")).toBeNull();
		expect(resolveSelfReadFile("ls", { path: "/a" }, "/proj")).toBeNull();
		expect(resolveSelfReadFile("bash", { command: "cat x" }, "/proj")).toBeNull();
	});

	it("returns null when path is missing or empty", () => {
		expect(resolveSelfReadFile("read", {}, "/proj")).toBeNull();
		expect(resolveSelfReadFile("read", { path: "   " }, "/proj")).toBeNull();
	});

	it("returns null for a sliced read (offset/limit delivers only a fragment)", () => {
		expect(resolveSelfReadFile("read", { path: "CLAUDE.md", offset: 10 }, "/proj")).toBeNull();
		expect(resolveSelfReadFile("read", { path: "CLAUDE.md", limit: 5 }, "/proj")).toBeNull();
		expect(resolveSelfReadFile("read", { path: "CLAUDE.md", offset: 1, limit: 5 }, "/proj")).toBeNull();
	});
});

describe("resolveBashDeliveredFiles", () => {
	it("resolves a cat argument against the working directory", () => {
		expect(resolveBashDeliveredFiles("cat CLAUDE.md", "/proj/sub")).toEqual(["/proj/sub/CLAUDE.md"]);
	});

	it("does not treat a multi-file dump as a full delivery (tail truncation can evict an earlier file)", () => {
		// The bash tool tail-truncates the *combined* output, so `cat A.md B.md` cannot
		// guarantee A.md survived. Only a single-operand dump is a provable full delivery.
		expect(resolveBashDeliveredFiles("cat A.md B.md", "/proj")).toEqual([]);
	});

	it("does not treat a dump followed by other output as a full delivery", () => {
		// `cat CLAUDE.md && npm test` floods the tail with test output; the dumped file can
		// be truncated away from the visible window, so it must not be suppressed.
		expect(resolveBashDeliveredFiles("cat CLAUDE.md && npm test", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("cat CLAUDE.md && echo done", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("echo start && cat CLAUDE.md", "/proj")).toEqual([]);
	});

	it("returns an absolute argument unchanged", () => {
		expect(resolveBashDeliveredFiles("cat /a/CLAUDE.md", "/proj")).toEqual(["/a/CLAUDE.md"]);
	});

	it("expands a leading ~ in an argument", () => {
		expect(resolveBashDeliveredFiles("cat ~/x/CLAUDE.md", "/proj")).toEqual([join(homedir(), "x/CLAUDE.md")]);
	});

	it("supports bat as a full-dump command", () => {
		expect(resolveBashDeliveredFiles("bat CLAUDE.md", "/proj")).toEqual(["/proj/CLAUDE.md"]);
	});

	it("ignores flags and only collects file arguments", () => {
		expect(resolveBashDeliveredFiles("cat -n CLAUDE.md", "/proj")).toEqual(["/proj/CLAUDE.md"]);
	});

	it("strips surrounding quotes from an argument", () => {
		expect(resolveBashDeliveredFiles('cat "CLAUDE.md"', "/proj")).toEqual(["/proj/CLAUDE.md"]);
	});

	it("does not treat partial/interactive viewers as full delivery", () => {
		expect(resolveBashDeliveredFiles("head CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("tail -n 5 CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("less CLAUDE.md", "/proj")).toEqual([]);
	});

	it("does not treat non-dumping verbs as delivery", () => {
		expect(resolveBashDeliveredFiles("grep TODO CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("rm CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("git add CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("wc -l CLAUDE.md", "/proj")).toEqual([]);
	});

	it("skips a dump whose output is piped or redirected away", () => {
		expect(resolveBashDeliveredFiles("cat CLAUDE.md | grep x", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("cat CLAUDE.md > out.txt", "/proj")).toEqual([]);
	});

	it("skips a segment using a here-doc / here-string / input redirection", () => {
		// Tokens after `<<`/`<<<`/`<` are stdin body words, not dumped files — a heredoc that
		// merely mentions a context filename must not suppress it.
		expect(resolveBashDeliveredFiles("cat <<EOF\nsee CLAUDE.md\nEOF", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("cat <<< CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("cat < CLAUDE.md", "/proj")).toEqual([]);
	});

	it("returns nothing when the command chains more than one cd (ambiguous cwd)", () => {
		// Only the first `cd` is resolved into `workingDir`; a second `cd` makes operand
		// resolution wrong, so bail to the safe double-load.
		expect(resolveBashDeliveredFiles("cd /proj && cd sub && cat CLAUDE.md", "/proj")).toEqual([]);
	});

	it("does not treat bat's partial-range flag as a full dump", () => {
		expect(resolveBashDeliveredFiles("bat -r 10:20 CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("bat --line-range 10:20 CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("bat --line-range=10:20 CLAUDE.md", "/proj")).toEqual([]);
		// Attached short-flag form (`-r10:20`) — clap accepts an attached value.
		expect(resolveBashDeliveredFiles("bat -r10:20 CLAUDE.md", "/proj")).toEqual([]);
	});

	it("collects a cat that follows a leading cd segment", () => {
		expect(resolveBashDeliveredFiles("cd /proj/sub && cat CLAUDE.md", "/proj/sub")).toEqual(["/proj/sub/CLAUDE.md"]);
	});

	it("does not treat an uppercase command as a full dump (case-sensitive verb match)", () => {
		// Shell PATH lookup is case-sensitive on Linux: `CAT`/`Bat` are command-not-found and
		// emit nothing, so they must not be treated as delivering the file.
		expect(resolveBashDeliveredFiles("CAT CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("Cat CLAUDE.md", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("BAT CLAUDE.md", "/proj")).toEqual([]);
	});

	it("returns nothing for a full-dump command with no file operand", () => {
		// `cat` / `cat -n` reading stdin (or a flag-only invocation) names no file, so there
		// is nothing to suppress — the operand-count guard must keep it the safe direction.
		expect(resolveBashDeliveredFiles("cat", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("cat -n", "/proj")).toEqual([]);
		expect(resolveBashDeliveredFiles("bat --plain", "/proj")).toEqual([]);
	});

	it("returns an empty list for an empty command", () => {
		expect(resolveBashDeliveredFiles("", "/proj")).toEqual([]);
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
