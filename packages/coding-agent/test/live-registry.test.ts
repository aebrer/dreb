import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	deriveLiveStatus,
	HEARTBEAT_MS,
	isPidAlive,
	type LiveEntry,
	LiveSessionWriter,
	type LiveStatusResult,
	readLiveEntries,
	readLiveSessions,
	reapStale,
	removeLiveEntry,
	STALE_MS,
	writeLiveEntry,
} from "../src/core/live-registry.js";

const tempDirs: string[] = [];
const savedEnv = process.env[ENV_AGENT_DIR];

async function createAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dreb-live-registry-"));
	tempDirs.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

beforeEach(async () => {
	await createAgentDir();
});

afterEach(async () => {
	if (savedEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedEnv;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
	vi.useRealTimers();
});

function makeEntry(overrides: Partial<LiveEntry> = {}): LiveEntry {
	const now = 1_700_000_000_000;
	return {
		sessionId: "sess-1",
		// pid 1 (init) is always alive; isPidAlive(1) returns true via EPERM.
		pid: 1,
		cwd: "/tmp/proj-a",
		model: "test-model",
		status: "idle",
		lastActivity: now,
		lastHeartbeat: now,
		startedAt: now,
		...overrides,
	};
}

/** Return a guaranteed-dead pid by spawning a child and waiting for it to exit. */
function getDeadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"]);
		child.on("error", reject);
		child.on("exit", () => resolve(child.pid ?? 0));
	});
}

describe("writeLiveEntry / readLiveEntries", () => {
	it("round-trips an entry through the filesystem", () => {
		const entry = makeEntry({ sessionId: "abc123" });
		writeLiveEntry(entry);
		const read = readLiveEntries();
		expect(read).toHaveLength(1);
		expect(read[0]).toEqual(entry);
	});

	it("skips corrupt JSON files without throwing", async () => {
		const agentDir = process.env[ENV_AGENT_DIR]!;
		writeLiveEntry(makeEntry({ sessionId: "good" }));
		await writeFile(join(agentDir, "live", "corrupt.json"), "{not json", "utf8");
		await writeFile(join(agentDir, "live", "ignored.txt"), "x", "utf8");
		const read = readLiveEntries();
		expect(read.map((e) => e.sessionId)).toEqual(["good"]);
	});

	it("returns [] when the live dir does not exist", () => {
		expect(readLiveEntries()).toEqual([]);
	});
});

describe("removeLiveEntry", () => {
	it("removes the entry file and is safe on missing files", () => {
		writeLiveEntry(makeEntry({ sessionId: "gone" }));
		removeLiveEntry("gone");
		expect(readLiveEntries()).toEqual([]);
		expect(() => removeLiveEntry("never-existed")).not.toThrow();
	});
});

describe("reapStale", () => {
	it("keeps fresh entries and reaps expired heartbeats", () => {
		const now = 1_700_000_000_000;
		const fresh = makeEntry({ sessionId: "fresh", lastHeartbeat: now - STALE_MS + 1000 });
		const stale = makeEntry({ sessionId: "stale", lastHeartbeat: now - STALE_MS - 1000 });
		expect(reapStale([fresh, stale], now, () => true).map((e) => e.sessionId)).toEqual(["fresh"]);
	});

	it("keeps an entry exactly at the staleness threshold", () => {
		const now = 1_700_000_000_000;
		const atThreshold = makeEntry({ lastHeartbeat: now - STALE_MS });
		expect(reapStale([atThreshold], now, () => true)).toHaveLength(1);
	});

	it("reaps entries whose pid is dead even with a fresh heartbeat", async () => {
		const deadPid = await getDeadPid();
		const entry = makeEntry({ pid: deadPid, lastHeartbeat: Date.now() });
		expect(isPidAlive(deadPid)).toBe(false);
		expect(reapStale([entry], Date.now(), isPidAlive)).toEqual([]);
	});
});

describe("isPidAlive", () => {
	it("reports the current process alive", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});
});

describe("readLiveSessions", () => {
	it("excludes the self session and sorts by cwd then startedAt", async () => {
		const now = Date.now();
		const self = makeEntry({ sessionId: "self", pid: process.pid, cwd: "/tmp/mid" });
		const a = makeEntry({ sessionId: "a", cwd: "/tmp/a", startedAt: now + 100, lastHeartbeat: now });
		const b = makeEntry({ sessionId: "b", cwd: "/tmp/b", startedAt: now, lastHeartbeat: now });
		const bTie = makeEntry({ sessionId: "b2", cwd: "/tmp/b", startedAt: now + 50, lastHeartbeat: now });
		[self, b, a, bTie].forEach(writeLiveEntry);

		const sessions = readLiveSessions({ selfSessionId: "self", now });
		expect(sessions.map((e) => e.sessionId)).toEqual(["a", "b", "b2"]);
	});

	it("does not order by lastActivity", () => {
		const now = Date.now();
		const recentActivity = makeEntry({
			sessionId: "recent",
			cwd: "/tmp/zzz",
			lastActivity: now,
			lastHeartbeat: now,
			startedAt: now,
		});
		const oldActivity = makeEntry({
			sessionId: "old",
			cwd: "/tmp/aaa",
			lastActivity: now - 3600_000,
			lastHeartbeat: now,
			startedAt: now,
		});
		writeLiveEntry(recentActivity);
		writeLiveEntry(oldActivity);
		const sessions = readLiveSessions({ now });
		// cwd alphabetical wins even though "recent" has newer activity.
		expect(sessions.map((e) => e.sessionId)).toEqual(["old", "recent"]);
	});

	it("excludes entries whose pid matches the current process", () => {
		const now = Date.now();
		const samePid = makeEntry({ sessionId: "samepid", pid: process.pid, lastHeartbeat: now });
		const other = makeEntry({ sessionId: "other", pid: 1, lastHeartbeat: now });
		writeLiveEntry(samePid);
		writeLiveEntry(other);
		const sessions = readLiveSessions({ now, selfSessionId: "different" });
		expect(sessions.map((e) => e.sessionId)).toEqual(["other"]);
	});

	it("removes orphaned stale files while keeping fresh ones", () => {
		const now = Date.now();
		writeLiveEntry(makeEntry({ sessionId: "orphan", lastHeartbeat: now - STALE_MS - 5000 }));
		writeLiveEntry(makeEntry({ sessionId: "fresh", lastHeartbeat: now }));
		const sessions = readLiveSessions({ now, selfSessionId: "self" });
		expect(sessions.map((e) => e.sessionId)).toEqual(["fresh"]);
		// The orphan's file was reaped (stale); the fresh one remains.
		expect(readLiveEntries().map((e) => e.sessionId)).toEqual(["fresh"]);
	});

	it("never removes the self session's file", () => {
		const now = Date.now();
		// A self entry with an old heartbeat must not be cleaned up by readers.
		writeLiveEntry(makeEntry({ sessionId: "self", lastHeartbeat: now - STALE_MS - 5000 }));
		readLiveSessions({ now, selfSessionId: "self" });
		expect(readLiveEntries().map((e) => e.sessionId)).toContain("self");
	});
});

describe("deriveLiveStatus", () => {
	const base = {
		hasDialog: false,
		backgroundAgentsRunning: 0,
		streaming: false,
		compacting: false,
		pendingMessages: 0,
	};

	it("returns idle when no signals are active", () => {
		expect(deriveLiveStatus(base)).toEqual({ status: "idle" });
	});

	it("prefers error over everything", () => {
		const r = deriveLiveStatus({ ...base, error: "boom", hasDialog: true, streaming: true });
		expect(r).toEqual({ status: "error", reason: "boom" });
	});

	it("prefers a dialog (attention) over background agents and running", () => {
		const r = deriveLiveStatus({ ...base, hasDialog: true, backgroundAgentsRunning: 2, streaming: true });
		expect(r).toEqual({ status: "attention", reason: "waiting for input" });
	});

	it("reports background agents as attention with a count", () => {
		expect(deriveLiveStatus({ ...base, backgroundAgentsRunning: 1 })).toEqual({
			status: "attention",
			reason: "1 background agent running",
		});
		expect(deriveLiveStatus({ ...base, backgroundAgentsRunning: 3 })).toEqual({
			status: "attention",
			reason: "3 background agents running",
		});
	});

	it("reports running for streaming, compacting, and queued messages in priority order", () => {
		expect(deriveLiveStatus({ ...base, streaming: true, compacting: true, pendingMessages: 2 })).toEqual({
			status: "running",
			reason: "streaming",
		});
		expect(deriveLiveStatus({ ...base, compacting: true, pendingMessages: 2 })).toEqual({
			status: "running",
			reason: "compacting",
		});
		expect(deriveLiveStatus({ ...base, pendingMessages: 1 })).toEqual({
			status: "running",
			reason: "1 queued message",
		});
	});
});

describe("LiveSessionWriter", () => {
	it("writes on start, heartbeats, and removes the file on dispose", () => {
		vi.useFakeTimers();
		const statusProvider = vi.fn<() => LiveStatusResult>(() => ({ status: "idle" }));
		const modelProvider = vi.fn(() => "writer-model");
		const writer = new LiveSessionWriter({
			sessionId: "writer-sess",
			statusProvider,
			modelProvider,
			branchProvider: () => "main",
		});
		writer.start();

		// Initial write
		let entry = readLiveEntries().find((e) => e.sessionId === "writer-sess");
		expect(entry).toBeDefined();
		expect(entry!.model).toBe("writer-model");
		expect(entry!.branch).toBe("main");
		const firstHeartbeat = entry!.lastHeartbeat;

		// Advance past one heartbeat
		vi.advanceTimersByTime(HEARTBEAT_MS);
		entry = readLiveEntries().find((e) => e.sessionId === "writer-sess");
		expect(entry!.lastHeartbeat).toBeGreaterThan(firstHeartbeat);

		// A status change is picked up on the next tick
		statusProvider.mockReturnValue({ status: "running", reason: "streaming" });
		vi.advanceTimersByTime(HEARTBEAT_MS);
		entry = readLiveEntries().find((e) => e.sessionId === "writer-sess");
		expect(entry!.status).toBe("running");

		writer.dispose();
		expect(readLiveEntries().map((e) => e.sessionId)).not.toContain("writer-sess");

		// dispose is idempotent
		writer.dispose();
	});

	it("updates lastActivity only for running status", () => {
		vi.useFakeTimers();
		let status: "idle" | "running" = "idle";
		const writer = new LiveSessionWriter({
			sessionId: "activity-sess",
			statusProvider: () => ({ status }),
			modelProvider: () => "m",
		});
		writer.start();

		const initial = readLiveEntries().find((e) => e.sessionId === "activity-sess")!;
		// The initial write has activity == heartbeat.
		expect(initial.lastActivity).toBe(initial.lastHeartbeat);

		// An idle heartbeat advances the heartbeat but not lastActivity
		vi.advanceTimersByTime(HEARTBEAT_MS);
		let entry = readLiveEntries().find((e) => e.sessionId === "activity-sess")!;
		expect(entry.lastActivity).toBe(initial.lastActivity);
		expect(entry.lastHeartbeat).toBeGreaterThan(initial.lastHeartbeat);

		// A running heartbeat advances lastActivity
		status = "running";
		vi.advanceTimersByTime(HEARTBEAT_MS);
		entry = readLiveEntries().find((e) => e.sessionId === "activity-sess")!;
		expect(entry.lastActivity).toBe(entry.lastHeartbeat);
		expect(entry.lastActivity).toBeGreaterThan(initial.lastActivity);

		writer.dispose();
	});
});
