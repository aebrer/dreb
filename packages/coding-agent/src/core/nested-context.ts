import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CONTEXT_FILE_CANDIDATES, loadContextFilesFromDir, type ResourceDiagnostic } from "./resource-loader.js";
import { renderTerminalOutput } from "./tools/terminal-render.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./tools/truncate.js";

/**
 * Auto-load of nested AGENTS.md/CLAUDE.md context files.
 *
 * Project context files are only loaded at session start by walking *upward* from
 * `cwd`. When the agent (or a subagent) operates in a subdirectory — or in an entirely
 * different repo/project — that directory's context files are never loaded. This module
 * detects the directory a tool is about to operate in, walks up to a sensible ceiling
 * collecting context files, and returns a formatted block for injection into the tool
 * result (which is cache-safe — it does not rebuild the system prompt).
 */

/** A safety bound on how many directories the upward walk will visit. */
const MAX_WALK_DEPTH = 64;

/** Tools whose `path` argument identifies the directory being operated on. */
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

export interface LoadedContextFile {
	/** Absolute path of the loaded context file. */
	path: string;
	/** File content (HTML comments already stripped by the loader). */
	content: string;
}

export interface NestedContextCollection {
	/** Context files newly loaded during this collection pass. */
	files: LoadedContextFile[];
	/** Whether any existing context file failed to read and should be retried later. */
	hadReadError: boolean;
}

/**
 * Extract the target of a leading `cd <dir>` from a bash command.
 *
 * Covers the overwhelming majority of directory-changing bash commands (analysis of
 * real session logs: ~75% of bash calls start with `cd`, ~97% of those with an absolute
 * path). Returns the raw, unresolved path string (with a leading `~` preserved) or
 * `null` when the command does not begin with a simple `cd`.
 */
export function parseLeadingCd(command: string): string | null {
	if (typeof command !== "string") return null;

	const leadingCd = command.match(/^\s*cd\s+/);
	if (!leadingCd) return null;

	let rest = command.slice(leadingCd[0].length);
	while (true) {
		// Match either a quoted path or an unquoted token that stops at the first shell
		// separator (&&, ;, |, newline) or whitespace.
		const match = rest.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s&;|<>]+))/);
		if (!match) return null;

		const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (!target) return null;

		// `cd -` means "previous directory" and cannot be resolved cheaply.
		if (target === "-") return null;

		// Skip leading options (`cd -P /x`, `cd -L /x`). After `--`, the next token is
		// the path even if it begins with `-`.
		if (target === "--") {
			rest = rest.slice(match[0].length);
			const pathMatch = rest.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s&;|<>]+))/);
			if (!pathMatch) return null;
			const pathTarget = (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3] ?? "").trim();
			if (!pathTarget || pathTarget.startsWith("$")) return null;
			return pathTarget;
		}
		if (target.startsWith("-")) {
			rest = rest.slice(match[0].length);
			continue;
		}

		// Skip variable-based targets we cannot resolve cheaply.
		if (target.startsWith("$")) return null;
		return target;
	}
}

/**
 * Expand a leading `~` to the home directory and resolve a raw path string to an absolute
 * path against `baseDir`. Shared by every place that turns a user-supplied path token into
 * an absolute path (`resolveTargetDir`, `resolveSelfReadFile`, bash argument resolution).
 */
function expandToAbsolute(rawPath: string, baseDir: string): string {
	if (rawPath === "~") {
		rawPath = homedir();
	} else if (rawPath.startsWith(`~${sep}`) || rawPath.startsWith("~/")) {
		rawPath = join(homedir(), rawPath.slice(2));
	}
	return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

/**
 * Resolve the absolute directory a tool call is about to operate in, or `null` when the
 * tool/argument shape does not identify a directory we should react to.
 */
export function resolveTargetDir(
	toolName: string,
	args: Record<string, unknown> | undefined,
	cwd: string,
): string | null {
	if (!args) return null;

	let rawPath: string | null = null;

	if (toolName === "bash") {
		rawPath = parseLeadingCd(typeof args.command === "string" ? args.command : "");
	} else if (PATH_TOOLS.has(toolName)) {
		const p = args.path;
		if (typeof p === "string" && p.trim() !== "") {
			rawPath = p;
		}
	}

	if (!rawPath) return null;

	const absolute = expandToAbsolute(rawPath, cwd);

	// For path-bearing tools the argument is usually a file; for bash `cd` it is a
	// directory. Resolve to a directory: existing dirs are used as-is, everything else
	// (existing files, not-yet-created files) maps to its parent directory.
	try {
		if (existsSync(absolute) && statSync(absolute).isDirectory()) {
			return absolute;
		}
	} catch {
		// Fall through to dirname on permission/stat errors.
	}
	return dirname(absolute);
}

/** Safe realpath that falls back to the input on error. */
function safeRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function isWithin(parent: string, child: string): boolean {
	const p = safeRealpath(parent);
	const c = safeRealpath(child);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Build the ordered list of directories to inspect, from the target directory up to the
 * appropriate ceiling. Ordered outermost-first so the most specific (closest to the
 * target) context appears last, matching session-start precedence.
 *
 * Ceiling priority:
 *   1. `cwd` — when the target is within the cwd subtree (ancestors already loaded at start).
 *   2. The outermost git repo root in the chain (a directory containing `.git`).
 *   3. The outermost directory containing a CLAUDE.md/AGENTS.md.
 *   4. Hard stop at filesystem root, the depth bound, or a permission/stat failure.
 */
function resolveWalkDirs(targetDir: string, cwd: string): string[] {
	const root = resolve("/");

	// Case 1: target within cwd subtree — never walk above cwd.
	if (isWithin(cwd, targetDir)) {
		const dirs: string[] = [];
		let current = targetDir;
		const stop = safeRealpath(cwd);
		for (let i = 0; i < MAX_WALK_DEPTH; i++) {
			dirs.push(current);
			if (safeRealpath(current) === stop) break;
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
		return dirs.reverse();
	}

	// Case 2/3/4: target outside cwd — walk to the hard ceiling, recording git roots and
	// directories that hold context files, then bound to the outermost relevant ceiling.
	const chain: string[] = [];
	let highestGitRootIdx = -1;
	let highestContextIdx = -1;
	let current = targetDir;
	for (let i = 0; i < MAX_WALK_DEPTH; i++) {
		// A permission/stat failure on the directory itself stops the walk.
		try {
			statSync(current);
		} catch {
			break;
		}
		chain.push(current);
		const idx = chain.length - 1;
		try {
			if (existsSync(join(current, ".git"))) highestGitRootIdx = idx;
		} catch {
			// ignore
		}
		if (dirHasContextFile(current)) highestContextIdx = idx;

		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	let ceilingIdx: number;
	if (highestGitRootIdx >= 0) {
		ceilingIdx = highestGitRootIdx;
	} else if (highestContextIdx >= 0) {
		ceilingIdx = highestContextIdx;
	} else {
		ceilingIdx = chain.length - 1;
	}

	return chain.slice(0, ceilingIdx + 1).reverse();
}

/** Cheap check: does this directory hold any candidate context file? */
function dirHasContextFile(dir: string): boolean {
	for (const c of CONTEXT_FILE_CANDIDATES) {
		try {
			if (existsSync(join(dir, c))) return true;
		} catch {
			// ignore
		}
	}
	return false;
}

/**
 * Predicate deciding whether a collected context file should be *suppressed* from the
 * injected block because the triggering tool call already delivers its content (e.g. a
 * `read` of the file itself, or a `bash` command that prints it). Suppressed files are
 * still marked as loaded so they are never injected later — they are simply not
 * duplicated into the result that already contains them.
 */
export type SuppressPredicate = (file: LoadedContextFile) => boolean;

/**
 * Collect nested context files for `targetDir`, walking up to the ceiling described in
 * {@link resolveWalkDirs}. Files whose realpath is already in `alreadyLoaded` are skipped
 * (and not re-reported). Newly collected realpaths are added to `alreadyLoaded` so the
 * caller's per-session set stays authoritative and each file loads at most once. Also
 * reports whether an existing context file failed to read so callers can retry later
 * instead of negatively caching a transient failure.
 *
 * When `suppress` matches a newly-seen file, that file is marked loaded but excluded from
 * the returned `files` — the triggering tool result already contains it, so re-injecting
 * would duplicate the content and waste tokens.
 */
export function collectNestedContext(
	targetDir: string,
	cwd: string,
	alreadyLoaded: Set<string>,
	suppress?: SuppressPredicate,
): NestedContextCollection {
	const dirs = resolveWalkDirs(targetDir, cwd);
	const collected: LoadedContextFile[] = [];
	let hadReadError = false;
	for (const dir of dirs) {
		const diagnostics: ResourceDiagnostic[] = [];
		const files = loadContextFilesFromDir(dir, diagnostics);
		for (const diagnostic of diagnostics) {
			if (diagnostic.type !== "warning") continue;
			hadReadError = true;
			console.warn(
				`[nested-context] Nested context file existed but could not be read: ${diagnostic.path ?? dir} — ${diagnostic.message}`,
			);
		}
		for (const file of files) {
			const real = safeRealpath(file.path);
			if (alreadyLoaded.has(real)) continue;
			alreadyLoaded.add(real);
			// Mark loaded but do not inject: the triggering tool already delivers this file.
			if (suppress?.(file)) continue;
			collected.push(file);
		}
	}
	return { files: collected, hadReadError };
}

/**
 * Format collected context files into a single text block for injection into a tool
 * result. Leads with *why* the load happened and headers each file with its source path.
 * There is intentionally no size cap — oversized context files are the project's concern.
 */
export function formatNestedContextBlock(targetDir: string, files: LoadedContextFile[]): string {
	const header =
		`[dreb] Auto-loaded project context\n\n` +
		`A tool just operated in \`${targetDir}\`, whose project context had not been loaded yet. ` +
		`The file(s) below were loaded automatically to prevent missing important project context ` +
		`when working across multiple repos / projects / folders. ` +
		`(Disable with the \`context.autoLoadNested\` setting.)`;

	const sections = files.map(
		(f) =>
			`===== BEGIN project context: ${f.path} =====\n${f.content.trim()}\n===== END project context: ${f.path} =====`,
	);

	return `${header}\n\n${sections.join("\n\n")}`;
}

/**
 * Resolve the absolute file path a `read` tool call delivers, or `null` when the tool is
 * not `read` or has no usable `path`. Only `read` returns the *full* file content, so it
 * is the only path-tool whose result fully duplicates an injected context file. (`grep`
 * returns matched lines, `ls`/`edit`/`write` do not echo the whole file — those still
 * benefit from injection.)
 */
export function resolveSelfReadFile(
	toolName: string,
	args: Record<string, unknown> | undefined,
	cwd: string,
): string | null {
	if (!args || toolName !== "read") return null;
	// A sliced read (`offset`/`limit`) delivers only a fragment of the file — the same
	// hazard for which bash partial viewers (`head`/`tail`) are excluded. Treating it as a
	// full delivery would suppress (and permanently mark loaded) a file the result only
	// partially contains, silently dropping the rest. Fall back to the safe double-load.
	if (args.offset !== undefined || args.limit !== undefined) return null;
	const p = args.path;
	if (typeof p !== "string" || p.trim() === "") return null;
	return expandToAbsolute(p, cwd);
}

/**
 * Bash commands that dump a file's *full* contents to stdout. Deliberately narrow: only
 * commands that emit the whole file qualify. Partial viewers (`head`/`tail`) and
 * interactive pagers (`less`/`more`) are excluded — they may show only a fragment, so
 * treating them as "delivered" could silently drop the rest of a context file. The safe
 * failure mode is a harmless double-load (we still inject), never a silent context drop.
 *
 * `bat` is included but is *not* unconditionally a full dump: its `-r`/`--line-range` flag
 * emits only a range (same hazard as `head`/`tail`). Segments carrying that flag are
 * disqualified in {@link resolveBashDeliveredFiles}.
 */
const FULL_DUMP_COMMANDS = new Set(["cat", "bat"]);

/** `bat` flags that limit output to a partial range — disqualify the segment if present. */
const BAT_RANGE_FLAGS = ["-r", "--line-range"];

/**
 * Whether a `bat` token requests a partial line range. Matches the space-separated form
 * (`-r`, `--line-range`), the `=`-attached long form (`--line-range=10:20`), and the
 * attached short form (`-r10:20`) — clap accepts an attached value on a short flag, so a
 * bare `startsWith` check on each known range flag covers every spelling. A partial range
 * is the same hazard as `head`/`tail`: only a fragment is emitted, so the segment must not
 * be treated as a full dump.
 */
function isBatRangeFlag(token: string): boolean {
	return BAT_RANGE_FLAGS.some((flag) => token.startsWith(flag));
}

/** Strip a single layer of matching surrounding quotes from a shell token. */
function unquoteToken(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/**
 * Resolve the absolute paths of files a bash command fully delivers to stdout via a
 * full-dump command (`cat`/`bat`). Path arguments are resolved against `workingDir` (the
 * command's effective cwd — e.g. a leading `cd` target). Conservative on purpose:
 *
 *  - Segments are split on `&&`, `||`, `;`. Segments that are *only* a `cd` produce no
 *    stdout and are ignored, but there must be **exactly one** remaining output-producing
 *    segment. The bash tool truncates its *combined* command output from the **tail**
 *    (keeping the last {@link DEFAULT_MAX_LINES} lines / {@link DEFAULT_MAX_BYTES} bytes and
 *    dropping the head), so any *additional* output-producing segment could evict the dumped
 *    file from the visible window while {@link deliveredInFull} — which measures the file
 *    alone — still reports a full delivery. Bail to the safe double-load in that case.
 *  - That sole segment must not contain a pipe (`|`), output redirection (`>`), or input
 *    redirection / here-doc / here-string (`<`, `<<`, `<<<`) — its output is filtered /
 *    redirected, or its operands are stdin body words rather than dumped files.
 *  - Its first token must be `cat`/`bat`; flags (`-…`) are ignored.
 *  - A `bat` segment carrying a partial-range flag (`-r`/`--line-range`, any spelling) is
 *    skipped — it emits only a fragment, like `head`/`tail`.
 *  - It must have **exactly one** file operand. A multi-file dump (`cat A.md B.md`)
 *    concatenates several files; under tail truncation an earlier operand can be evicted
 *    while still appearing fully sized on disk, so it is not a provable full delivery.
 *  - If the command chains more than one `cd`, the effective cwd is ambiguous (we only
 *    resolved the *first* `cd`), so operands cannot be resolved reliably — return nothing.
 *
 * Anything we cannot confidently classify as a full delivery is omitted, so the worst case
 * is a double-load rather than a silently dropped context file.
 */
export function resolveBashDeliveredFiles(command: string, workingDir: string): string[] {
	if (typeof command !== "string" || command.trim() === "") return [];
	const segments = command.split(/&&|\|\||;/);
	const isCdSegment = (s: string) => /^\s*cd(\s|$)/.test(s);

	// More than one `cd` means the effective cwd differs from the first `cd` target we
	// resolved as `workingDir`; resolving operands against it would suppress the wrong
	// (same-named) file. Bail to the safe double-load.
	if (segments.filter(isCdSegment).length > 1) return [];

	// Segments that are only a `cd` emit no stdout. Everything else produces output, and
	// because the bash tool tail-truncates the *combined* output, a context file is only
	// provably delivered in full when it is the command's *sole* output-producing segment.
	const outputSegments = segments.filter((s) => s.trim() !== "" && !isCdSegment(s));
	if (outputSegments.length !== 1) return [];

	const segment = outputSegments[0];
	// Output piped/redirected, or operands fed via input redirection / here-doc, are not raw
	// file dumps to stdout.
	if (segment.includes("|") || segment.includes(">") || segment.includes("<")) return [];
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];
	// Match the command verb case-sensitively: shell PATH lookup is case-sensitive on
	// Linux, so `CAT`/`Bat` are command-not-found and emit nothing to stdout. Lowercasing
	// would let them match the allowlist and falsely suppress a file they never printed —
	// a silent context drop. Exact matching keeps the failure mode a harmless double-load.
	const cmd = tokens[0];
	if (!FULL_DUMP_COMMANDS.has(cmd)) return [];
	// `bat -r 10:20` / `bat -r10:20` / `bat --line-range=10:20` shows only a range — not a full dump.
	if (cmd === "bat" && tokens.slice(1).some(isBatRangeFlag)) return [];

	const operands: string[] = [];
	for (const token of tokens.slice(1)) {
		if (token.startsWith("-")) continue; // flag, not a file argument
		const arg = unquoteToken(token);
		if (arg === "") continue;
		operands.push(arg);
	}
	// A single operand is the only provable full delivery: multi-file dumps concatenate,
	// and tail truncation can evict an earlier file while it still looks fully sized.
	if (operands.length !== 1) return [];
	return [expandToAbsolute(operands[0], workingDir)];
}

export interface NestedContextState {
	/** Whether auto-loading is enabled (the `context.autoLoadNested` setting). */
	enabled: boolean;
	/** The session's working directory. */
	cwd: string;
	/** Realpaths of context files already loaded this session (seeded at session start). Mutated. */
	loaded: Set<string>;
	/** Realpaths of directories already scanned (negative cache). Mutated. */
	scannedDirs: Set<string>;
}

/**
 * Whether a tool that delivers `realPath` actually delivers its *full* content. Both `read`
 * and `bash` truncate their output at {@link DEFAULT_MAX_LINES} lines / {@link DEFAULT_MAX_BYTES}
 * bytes, while {@link formatNestedContextBlock} is uncapped. If the file exceeds either limit
 * it is delivered truncated, so suppressing (and permanently marking loaded) would silently
 * drop the remainder. Any stat/read failure also returns `false` — the safe double-load.
 *
 * `rendered` selects which delivery the measure must mirror:
 *  - `read` delivers the file's raw content unchanged (`truncateHead` with no transform), so
 *    the raw byte/line count is exact.
 *  - `bash` delivers `truncateTail(renderTerminalOutput(...))`, and terminal rendering expands
 *    tabs to 8-column stops and resolves cursor/ANSI sequences — the rendered output can be
 *    *larger* than the file on disk. A tab-dense file just under the budget on disk can render
 *    past it and be tail-truncated (its head dropped) while the raw measure still reports a
 *    full delivery. Measuring the rendered output keeps the failure mode a harmless double-load
 *    rather than a silent context drop.
 */
function deliveredInFull(realPath: string, rendered: boolean): boolean {
	try {
		// Cheap early-out: the raw on-disk size is a lower bound on the delivered size
		// (terminal rendering only ever grows the byte count), so a file already over the
		// byte budget on disk is certainly delivered truncated.
		if (statSync(realPath).size > DEFAULT_MAX_BYTES) return false;
		const raw = readFileSync(realPath, "utf8");
		const delivered = rendered ? renderTerminalOutput(raw) : raw;
		if (Buffer.byteLength(delivered, "utf-8") > DEFAULT_MAX_BYTES) return false;
		return delivered.split("\n").length <= DEFAULT_MAX_LINES;
	} catch {
		return false;
	}
}

/**
 * Orchestrate a single nested-context decision for a tool call: gate on the setting,
 * resolve the target directory, skip directories already scanned (negative cache),
 * collect not-yet-loaded context files, and format them. Returns the injection block or
 * `null` when nothing should be injected. Mutates `state.scannedDirs` and `state.loaded`.
 */
export function computeNestedContextBlock(
	toolName: string,
	args: Record<string, unknown> | undefined,
	state: NestedContextState,
): string | null {
	if (!state.enabled) return null;

	const targetDir = resolveTargetDir(toolName, args, state.cwd);
	if (!targetDir) return null;

	const realTarget = safeRealpath(targetDir);
	if (state.scannedDirs.has(realTarget)) return null;

	// A context file the triggering tool already delivers should be marked loaded but not
	// re-injected (the result already contains it). Two cases: a `read` of the file itself,
	// or a `bash` command that dumps its full contents (`cat`/`bat`). Both are matched by
	// full resolved realpath — never by basename — so printing one file never suppresses a
	// same-named sibling/ancestor or a file in a different directory.
	const selfReadFile = resolveSelfReadFile(toolName, args, state.cwd);
	const realSelfReadFile = selfReadFile ? safeRealpath(selfReadFile) : null;
	const bashCommand = toolName === "bash" && typeof args?.command === "string" ? args.command : null;
	// Bash file arguments resolve against the command's effective cwd, which `resolveTargetDir`
	// has already computed as `targetDir` (the leading `cd` destination).
	const bashDelivered = bashCommand
		? new Set(resolveBashDeliveredFiles(bashCommand, targetDir).map(safeRealpath))
		: null;
	const suppress: SuppressPredicate = (file) => {
		const realFile = safeRealpath(file.path);
		// Only suppress when the file was delivered *in full*: a truncated delivery (oversized
		// file) would drop the remainder if we marked it fully loaded and skipped injection.
		// `read` delivers the file's raw content unchanged; `bash` delivers it through terminal
		// rendering (tab/ANSI expansion can grow it past the truncation budget), so each path
		// measures fullness against what it actually emits.
		if (realFile === realSelfReadFile) return deliveredInFull(realFile, false);
		if (bashDelivered?.has(realFile)) return deliveredInFull(realFile, true);
		return false;
	};

	const collected = collectNestedContext(targetDir, state.cwd, state.loaded, suppress);
	if (!collected.hadReadError) {
		state.scannedDirs.add(realTarget);
	}
	if (collected.files.length === 0) return null;
	return formatNestedContextBlock(targetDir, collected.files);
}
