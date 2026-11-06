import { describe, expect, it } from "vitest";
import {
	filterFleetDiskSessions,
	filterFleetRuntimes,
	fleetDisplayPath,
	normalizeFleetQuery,
} from "../../src/client/state/fleet-filtering.js";
import { DEFAULT_FLEET_SORT, sortFleetDiskGroups, sortFleetRuntimes } from "../../src/client/state/fleet-sorting.js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../src/shared/protocol.js";

const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
function runtime(key: string, over: Partial<RuntimeInfoDto> = {}): RuntimeInfoDto {
	return {
		key,
		cwd: "/current/project",
		state: {
			sessionId: `${key}-session-id`,
			sessionFile: `/sessions/${key}.jsonl`,
			sessionName: key,
			tasks: [],
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 1,
			pendingMessageCount: 0,
		},
		backgroundAgents: [],
		needsAttention: false,
		createdAt: day(1),
		lastActivity: day(1),
		...over,
	};
}
function disk(id: string, over: Partial<SessionInfoDto> = {}): SessionInfoDto {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/historical/project",
		name: id,
		created: day(1),
		modified: day(1),
		messageCount: 1,
		firstMessage: `preview ${id}`,
		...over,
	};
}
function deepFreeze<T extends object>(value: T): T {
	for (const child of Object.values(value)) {
		if (child && typeof child === "object") deepFreeze(child);
	}
	return Object.freeze(value);
}

const keys = (runtimes: readonly RuntimeInfoDto[]) => runtimes.map((r) => r.key);
const ids = (sessions: readonly SessionInfoDto[]) => sessions.map((s) => s.id);

describe("Fleet search normalization", () => {
	it.each([
		["", ""],
		[" \t\n ", ""],
		["  MiXeD Case\n", "mixed case"],
		["two  words", "two  words"],
		[" /HOME/User/Project ", "/home/user/project"],
	])("normalizes %j to %j without rewriting interior text", (query, expected) => {
		expect(normalizeFleetQuery(query)).toBe(expected);
	});

	it("treats whitespace as no search and literal substrings rather than patterns or tokens", () => {
		const live = [runtime("Release [Plan]"), runtime("release plan")];
		const past = [disk("Release [Plan]"), disk("release plan")];
		expect(filterFleetRuntimes(live, " \n ", false)).toEqual(live);
		expect(filterFleetDiskSessions(past, " \n ")).toEqual(past);
		expect(keys(filterFleetRuntimes(live, " [pLaN] ", false))).toEqual(["Release [Plan]"]);
		expect(ids(filterFleetDiskSessions(past, " [pLaN] "))).toEqual(["Release [Plan]"]);
		expect(filterFleetRuntimes(live, "release missing", false)).toEqual([]);
		expect(filterFleetDiskSessions(past, "release missing")).toEqual([]);
	});
});

describe("Fleet displayed names", () => {
	it("uses the current local live name instead of a stale runtime name", () => {
		const r = runtime("Old cached name");
		const localName = () => "New LOCAL name";
		expect(filterFleetRuntimes([r], " local ", false, localName)).toEqual([r]);
		expect(filterFleetRuntimes([r], "old cached", false, localName)).toEqual([]);
		expect(filterFleetRuntimes([r], "CACHED", false)).toEqual([r]);
	});

	it("searches only the displayed live ID prefix when no name exists", () => {
		const r = runtime("opaque-key");
		r.state.sessionId = "AbCd1234-hidden-id-tail";
		r.state.sessionName = undefined;
		expect(filterFleetRuntimes([r], " bCD123 ", false)).toEqual([r]);
		expect(filterFleetRuntimes([r], "hidden-id-tail", false)).toEqual([]);
		expect(filterFleetRuntimes([r], "opaque-key", false)).toEqual([]);
	});

	it("preserves explicit empty live names and local overrides instead of falling back", () => {
		const r = runtime("cached-name");
		expect(filterFleetRuntimes([r], "cached-name", false, () => "")).toEqual([]);
		expect(filterFleetRuntimes([r], "", false, () => "")).toEqual([r]);
		r.state.sessionName = "";
		expect(filterFleetRuntimes([r], "cached", false)).toEqual([]);
		expect(filterFleetRuntimes([r], "current/project", false)).toEqual([r]);
	});

	it("searches historical names or the exact bounded, displayed first-message fallback", () => {
		const named = disk("named", { name: "Fix Search", firstMessage: "hidden preview" });
		const unnamed = disk("unnamed", { name: undefined, firstMessage: `${"Visible ".repeat(10)}hidden-tail` });
		const empty = disk("empty", { name: "", firstMessage: "hidden preview" });
		expect(filterFleetDiskSessions([named, unnamed, empty], "SEARCH")).toEqual([named]);
		expect(filterFleetDiskSessions([named, unnamed, empty], "“visible")).toEqual([unnamed]);
		expect(filterFleetDiskSessions([named, unnamed, empty], "…")).toEqual([unnamed]);
		expect(filterFleetDiskSessions([named, unnamed, empty], "hidden")).toEqual([]);
		expect(filterFleetDiskSessions([empty], "")).toEqual([empty]);
	});
});

describe("Fleet project paths and search boundaries", () => {
	it.each(["/home/Alice/Work/Repo", "~/Work/Repo", " work/re "])(
		"matches full and displayed project paths case-insensitively: %s",
		(query) => {
			const r = runtime("live", { cwd: "/home/alice/work/repo" });
			const s = disk("past", { cwd: "/home/alice/work/repo" });
			expect(filterFleetRuntimes([r], query, false)).toEqual([r]);
			expect(filterFleetDiskSessions([s], query)).toEqual([s]);
		},
	);

	it("uses the same displayed home alias without rewriting other paths", () => {
		expect(fleetDisplayPath("/home/alice/work")).toBe("~/work");
		expect(fleetDisplayPath("/home/alice")).toBe("~");
		expect(fleetDisplayPath("/Users/alice/work")).toBe("/Users/alice/work");
		expect(fleetDisplayPath("/tmp/project")).toBe("/tmp/project");
	});

	it("keeps historical CWD authoritative rather than canonical resume paths", () => {
		const s = disk("past", {
			cwd: "/home/alice/old-link",
			resolvedCwd: "/canonical/resume-target",
			cwdAvailable: false,
		});
		expect(filterFleetDiskSessions([s], "~/OLD-LINK")).toEqual([s]);
		expect(filterFleetDiskSessions([s], "canonical/resume-target")).toEqual([]);
		expect(s.cwd).toBe("/home/alice/old-link");
	});

	it("matches the folded /tmp group and original individual paths without changing action identities", () => {
		const a = disk("a", { cwd: "/tmp/work-one" });
		const b = disk("b", { cwd: "/tmp/work-two" });
		const filtered = filterFleetDiskSessions([a, b], " /TMP ");
		const groups = sortFleetDiskGroups(filtered, [], DEFAULT_FLEET_SORT);
		expect(groups.map(([project]) => project)).toEqual(["/tmp"]);
		expect(groups[0][1]).toEqual([a, b]);
		expect(filterFleetDiskSessions([a, b], "work-TWO")).toEqual([b]);
		expect(groups[0][1][1]).toBe(b);
		expect(b.cwd).toBe("/tmp/work-two");
		expect(b.path).toBe("/sessions/b.jsonl");
	});

	it("does not search opaque file paths, original live paths, errors, or assistant previews", () => {
		const r = runtime("live", {
			lastAssistantText: "assistant-secret",
			error: "error-secret",
		});
		r.state.sessionFile = "/opaque-file-secret/live.jsonl";
		const s = disk("opaque-id-secret", {
			path: r.state.sessionFile,
			cwd: "/old-cwd-secret",
			name: "named history",
			firstMessage: "transcript-secret",
		});
		for (const query of ["assistant-secret", "error-secret", "opaque-file-secret", "old-cwd-secret"])
			expect(filterFleetRuntimes([r], query, false)).toEqual([]);
		for (const query of ["opaque-file-secret", "opaque-id-secret", "transcript-secret"])
			expect(filterFleetDiskSessions([s], query)).toEqual([]);
		expect(filterFleetDiskSessions([s], "old-cwd-secret")).toEqual([s]);
	});
});

describe("Fleet attention and inventory independence", () => {
	it("uses needsAttention exactly, including flagged errors, rather than the visible status chip", () => {
		const flaggedError = runtime("Flagged error", { needsAttention: true, error: "failed" });
		const flagged = runtime("Flagged idle", { needsAttention: true });
		const errorOnly = runtime("Error only", { error: "failed" });
		const busy = runtime("Streaming");
		busy.state.isStreaming = true;
		const live = [errorOnly, flaggedError, busy, flagged];
		expect(filterFleetRuntimes(live, "", true)).toEqual([flaggedError, flagged]);
		expect(filterFleetRuntimes(live, " ERROR ", true)).toEqual([flaggedError]);
		expect(filterFleetRuntimes(live, "", false)).toEqual(live);
	});

	it.each([
		["past", false],
		["needle", true],
	] as const)("never leaks live files into history with query %s and attention %s", (query, attentionOnly) => {
		const r = runtime("Needle", { cwd: "/moved/runtime" });
		const liveFile = disk("live-record", { path: r.state.sessionFile!, name: "Needle past" });
		const past = disk("past-record", { name: "Needle past" });
		const inventory = [liveFile, past];
		expect(filterFleetRuntimes([r], query, attentionOnly)).toEqual([]);
		const matches = filterFleetDiskSessions(inventory, query);
		expect(matches).toEqual(inventory);
		// Membership is decided with ALL runtimes, not the filtered live result.
		expect(sortFleetDiskGroups(matches, [r], DEFAULT_FLEET_SORT)).toEqual([[past.cwd, [past]]]);
	});

	it("keeps full inventory available for live original-creation sorting even when metadata does not match", () => {
		const old = runtime("z-old");
		const newer = runtime("a-newer");
		old.state.sessionName = newer.state.sessionName = "Needle";
		const inventory = [disk("z-old", { created: day(1) }), disk("a-newer", { created: day(3) })];
		expect(filterFleetDiskSessions(inventory, "needle")).toEqual([]);
		expect(
			keys(
				sortFleetRuntimes(filterFleetRuntimes([newer, old], "needle", false), inventory, {
					key: "created",
					direction: "asc",
				}),
			),
		).toEqual(["z-old", "a-newer"]);
	});

	it("reranks historical groups by their matching leading member", () => {
		const inventory = [
			disk("a-hidden", { cwd: "/a", modified: day(20) }),
			disk("a-match", { cwd: "/a", name: "Needle", modified: day(1) }),
			disk("b-match", { cwd: "/b", name: "Needle", modified: day(10) }),
		];
		expect(sortFleetDiskGroups(inventory, [], DEFAULT_FLEET_SORT).map(([project]) => project)).toEqual(["/a", "/b"]);
		const groups = sortFleetDiskGroups(filterFleetDiskSessions(inventory, "needle"), [], DEFAULT_FLEET_SORT);
		expect(groups.map(([project]) => project)).toEqual(["/b", "/a"]);
		expect(groups.map(([, sessions]) => ids(sessions))).toEqual([["b-match"], ["a-match"]]);
	});

	it("filters the complete history before a three-row preview and retains the full matching total", () => {
		const inventory = Array.from({ length: 8 }, (_, index) =>
			disk(String(index), { name: index < 3 ? "unrelated" : "Needle", modified: day(20 - index) }),
		);
		const groups = sortFleetDiskGroups(filterFleetDiskSessions(inventory, "needle"), [], DEFAULT_FLEET_SORT);
		expect(groups[0][1]).toHaveLength(5);
		expect(ids(groups[0][1].slice(0, 3))).toEqual(["3", "4", "5"]);
	});

	it("accepts frozen arrays and nested DTOs without mutation, copying arrays but retaining stable member identities", () => {
		const live = deepFreeze([runtime("second", { needsAttention: true }), runtime("first")]);
		const inventory = deepFreeze([disk("second"), disk("first")]);
		const before = JSON.stringify({ live, inventory });
		for (const query of ["", "project", "missing"]) {
			for (const attentionOnly of [false, true]) filterFleetRuntimes(live, query, attentionOnly, () => "Local");
			filterFleetDiskSessions(inventory, query);
		}
		const liveResult = filterFleetRuntimes(live, "", false);
		const diskResult = filterFleetDiskSessions(inventory, "");
		expect(liveResult).not.toBe(live);
		expect(diskResult).not.toBe(inventory);
		expect(liveResult).toEqual(live);
		expect(diskResult).toEqual(inventory);
		expect(liveResult[0]).toBe(live[0]);
		expect(diskResult[0]).toBe(inventory[0]);
		expect(JSON.stringify({ live, inventory })).toBe(before);
		expect(filterFleetRuntimes([], "", true)).toEqual([]);
		expect(filterFleetDiskSessions([], "")).toEqual([]);
	});
});
