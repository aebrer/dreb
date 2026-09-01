/**
 * Per-session liveness registry.
 *
 * Each interactive session writes a small JSON state file under
 * `<agentDir>/live/` at startup, heartbeats it on a timer, and removes it on
 * clean exit. A reader reaps stale entries (expired heartbeat or dead pid),
 * excludes the calling session, and returns the remaining live sessions
 * sorted deterministically (cwd alphabetical, then startedAt).
 *
 * Clean-exit removal is best-effort only: `kill -9`/crashes orphan the file.
 * Stale reaping (not removal) is what guarantees correctness, so a stale
 * entry is never displayed even if its file was never removed.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";

/** Session liveness status. Matches the dashboard status vocabulary. */
export type LiveStatus = "running" | "attention" | "idle" | "error";

/** A single live-session registry entry (one JSON file per session). */
export interface LiveEntry {
	sessionId: string;
	pid: number;
	cwd: string;
	/** Git branch, if the cwd is inside a repository. */
	branch?: string;
	model: string;
	status: LiveStatus;
	/** Human-readable reason for the status (e.g. "waiting for input"). */
	statusReason?: string;
	/** Last time the session did real work (epoch ms). */
	lastActivity: number;
	/** Last heartbeat time (epoch ms). Updated unconditionally each tick. */
	lastHeartbeat: number;
	/** Session start time (epoch ms). */
	startedAt: number;
}

/** Heartbeat interval: an idle session still heartbeats this often. */
export const HEARTBEAT_MS = 1500;

/**
 * A heartbeat older than this means the session is gone. Chosen tolerant of
 * briefly blocked event loops (sync file operations, git calls, etc.), well
 * above the 1.5s heartbeat interval.
 */
export const STALE_MS = 7000;

/** Directory holding one JSON file per live session. */
export function getLiveDir(): string {
	return join(getAgentDir(), "live");
}

function entryFile(sessionId: string): string {
	return join(getLiveDir(), `${sessionId}.json`);
}

/** True if the given pid refers to a running process. EPERM means alive (owned by another user). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Atomically write a live entry (tmp file + rename), so readers never observe
 * a torn write.
 */
export function writeLiveEntry(entry: LiveEntry): void {
	const dir = getLiveDir();
	mkdirSync(dir, { recursive: true });
	const file = entryFile(entry.sessionId);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry));
	renameSync(tmp, file);
}

/** Read all parseable live entries. Corrupt files are skipped. */
export function readLiveEntries(): LiveEntry[] {
	let files: string[];
	try {
		files = readdirSync(getLiveDir());
	} catch {
		return [];
	}
	const entries: LiveEntry[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(getLiveDir(), file), "utf8")) as LiveEntry;
			if (typeof parsed?.sessionId === "string" && typeof parsed?.lastHeartbeat === "number") {
				entries.push(parsed);
			}
		} catch {
			// Corrupt/unreadable file — skip it.
		}
	}
	return entries;
}

/** Remove a session's live entry file (best-effort). */
export function removeLiveEntry(sessionId: string): void {
	try {
		rmSync(entryFile(sessionId), { force: true });
	} catch {
		// Best-effort cleanup.
	}
}

/**
 * Pure staleness filter. An entry is stale when its heartbeat is strictly
 * older than STALE_MS, or its pid is dead. An entry exactly at the threshold
 * is kept (deterministic boundary).
 */
export function reapStale(
	entries: readonly LiveEntry[],
	now: number,
	pidAlive: (pid: number) => boolean = isPidAlive,
): LiveEntry[] {
	return entries.filter((e) => now - e.lastHeartbeat <= STALE_MS && pidAlive(e.pid));
}

/**
 * Read the registry, reap stale entries (removing their orphaned files
 * best-effort), exclude the calling session (by sessionId and pid), and sort
 * deterministically: cwd alphabetical, then startedAt ascending. Never by
 * lastActivity/lastHeartbeat — those make the list jump on every refresh.
 */
export function readLiveSessions(opts: { selfSessionId?: string; now?: number } = {}): LiveEntry[] {
	const now = opts.now ?? Date.now();
	const all = readLiveEntries();
	const fresh = reapStale(all, now);
	const freshIds = new Set(fresh.map((e) => e.sessionId));
	// Clean up orphaned files (stale entries) — never our own file.
	for (const e of all) {
		if (!freshIds.has(e.sessionId) && e.sessionId !== opts.selfSessionId) {
			removeLiveEntry(e.sessionId);
		}
	}
	const selfPid = process.pid;
	const others = fresh.filter(
		(e) => (opts.selfSessionId === undefined || e.sessionId !== opts.selfSessionId) && e.pid !== selfPid,
	);
	others.sort((a, b) => (a.cwd === b.cwd ? a.startedAt - b.startedAt : a.cwd < b.cwd ? -1 : 1));
	return others;
}

/** Signals describing the current session's state, for status composition. */
export interface LiveStatusSignals {
	/** Fatal error message (AgentState.error), if present. */
	error?: string | null;
	/** A pending user-facing dialog (ask_user / selector / input / editor). */
	hasDialog: boolean;
	/** Number of currently running background agents. */
	backgroundAgentsRunning: number;
	/** Agent is streaming a response. */
	streaming: boolean;
	/** Context compaction is in progress. */
	compacting: boolean;
	/** Number of queued user messages. */
	pendingMessages: number;
}

/** Composed live status and an optional human-readable reason. */
export interface LiveStatusResult {
	status: LiveStatus;
	reason?: string;
}

/**
 * Compose a live status from scattered signals. There is no single source of
 * truth for status in interactive mode, so priority mirrors the dashboard
 * (runtimeStatus in fleet.tsx): error > attention > running > idle.
 */
export function deriveLiveStatus(signals: LiveStatusSignals): LiveStatusResult {
	if (signals.error) return { status: "error", reason: signals.error };
	if (signals.hasDialog) return { status: "attention", reason: "waiting for input" };
	if (signals.backgroundAgentsRunning > 0) {
		return {
			status: "attention",
			reason: `${signals.backgroundAgentsRunning} background agent${
				signals.backgroundAgentsRunning === 1 ? "" : "s"
			} running`,
		};
	}
	if (signals.streaming) return { status: "running", reason: "streaming" };
	if (signals.compacting) return { status: "running", reason: "compacting" };
	if (signals.pendingMessages > 0) {
		return {
			status: "running",
			reason: `${signals.pendingMessages} queued message${signals.pendingMessages === 1 ? "" : "s"}`,
		};
	}
	return { status: "idle" };
}

export interface LiveSessionWriterOptions {
	sessionId: string;
	/** Returns the current composed status, re-read on every heartbeat tick. */
	statusProvider: () => LiveStatusResult;
	/** Returns the current model display name, re-read on every heartbeat tick. */
	modelProvider: () => string;
	/** Returns the current git branch (null outside a repo), re-read on every tick. */
	branchProvider?: () => string | null | undefined;
}

/**
 * Owns a session's live entry: writes it on start, heartbeats it on a timer
 * (re-reading status/model/branch each tick), and removes the file on
 * dispose. dispose() is idempotent.
 */
export class LiveSessionWriter {
	private readonly options: LiveSessionWriterOptions;
	private readonly entry: LiveEntry;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(options: LiveSessionWriterOptions) {
		const now = Date.now();
		this.options = options;
		this.entry = {
			sessionId: options.sessionId,
			pid: process.pid,
			cwd: process.cwd(),
			model: "unknown",
			status: "idle",
			lastActivity: now,
			lastHeartbeat: now,
			startedAt: now,
		};
	}

	/** Write the initial entry and start the heartbeat timer. */
	start(): void {
		if (this.timer) return;
		this.heartbeat();
		this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
	}

	/** A snapshot of the current entry. */
	getEntry(): LiveEntry {
		return { ...this.entry };
	}

	private heartbeat(): void {
		if (this.disposed) return;
		try {
			const now = Date.now();
			const { status, reason } = this.options.statusProvider();
			this.entry.status = status;
			this.entry.statusReason = reason;
			this.entry.model = this.options.modelProvider();
			const branch = this.options.branchProvider?.();
			this.entry.branch = branch || undefined;
			this.entry.lastHeartbeat = now;
			// lastActivity tracks real work; status/reason still refresh.
			if (status === "running") this.entry.lastActivity = now;
			writeLiveEntry(this.entry);
		} catch {
			// A registry failure must never crash the session.
		}
	}

	/** Stop the timer and remove the entry file. Safe to call multiple times. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		removeLiveEntry(this.options.sessionId);
	}
}
