import { describe, expect, it } from "vitest";
import {
	DEFAULT_FLEET_SORT,
	diskSessionDisplayName,
	FLEET_SORT_OPTIONS,
	type FleetSortDirection,
	type FleetSortKey,
	fleetGroupKey,
	isFleetDateSort,
	normalizeFleetSort,
	runtimeDisplayName,
	sortFleetDiskGroups,
	sortFleetRuntimes,
} from "../../src/client/state/fleet-sorting.js";
import type { RuntimeInfoDto, SessionInfoDto } from "../../src/shared/protocol.js";

const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
function runtime(key: string, over: Partial<RuntimeInfoDto> = {}): RuntimeInfoDto {
	return {
		key,
		cwd: `/${key}`,
		state: {
			sessionId: `${key}-session`,
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
		cwd: "/repo",
		name: id,
		created: day(1),
		modified: day(1),
		messageCount: 1,
		firstMessage: `preview ${id}`,
		...over,
	};
}
const keys = (runtimes: RuntimeInfoDto[]) => runtimes.map((r) => r.key);
const groups = (inventory: SessionInfoDto[], key: FleetSortKey, direction: FleetSortDirection = "asc") =>
	sortFleetDiskGroups(inventory, [], { key, direction }).map(([project, rows]) => [project, rows.map((s) => s.id)]);

const live = [
	runtime("a", { createdAt: day(3), lastActivity: day(2) }),
	runtime("b", { createdAt: day(1), lastActivity: day(3) }),
	runtime("c", { createdAt: day(2), lastActivity: day(1) }),
];
live[0].state.sessionName = "Zulu";
live[1].state.sessionName = "alpha";
live[2].state.sessionName = "middle";
const metadata = [disk("a", { created: day(1) }), disk("b", { created: day(3) }), disk("c", { created: day(2) })];

describe("Fleet runtime ordering", () => {
	it.each([
		["default", "abc"],
		["activity", "cab"],
		["created", "acb"],
		["started", "bca"],
		["name", "bca"],
		["path", "abc"],
	] as const)("sorts %s in both directions using the intended datum", (key, ascending) => {
		for (const direction of ["asc", "desc"] as const) {
			const expected = direction === "desc" && key !== "default" ? [...ascending].reverse() : [...ascending];
			expect(keys(sortFleetRuntimes([...live].reverse(), metadata, { key, direction }))).toEqual(expected);
		}
	});

	it("retains path/start Default despite activity, errors, or attention", () => {
		const aLate = runtime("a-late", { cwd: "/a", createdAt: day(3), lastActivity: day(30), error: "failed" });
		const aEarly = runtime("a-early", { cwd: "/a", createdAt: day(1), needsAttention: true });
		expect(keys(sortFleetRuntimes([runtime("b"), aLate, aEarly], [], DEFAULT_FLEET_SORT))).toEqual([
			"a-early",
			"a-late",
			"b",
		]);
	});

	// Key order deliberately disagrees with path and start order (runtime keys are
	// random hex), so dropping either stable dimension changes the result.
	const beforeDayOne = "2025-12-31T00:00:00.000Z";
	const pathFirstEarly = () => runtime("ffffffffffff", { cwd: "/a", createdAt: day(1), lastActivity: day(5) });
	const pathFirstLate = () => runtime("000000000000", { cwd: "/a", createdAt: day(3), lastActivity: day(5) });
	const pathSecondEarliest = () =>
		runtime("888888888888", { cwd: "/b", createdAt: beforeDayOne, lastActivity: day(5) });
	const permutations = <T>(items: T[]): T[][] => [
		items,
		[...items].reverse(),
		[items[1], items[0], items[2]],
		[items[2], items[0], items[1]],
	];

	it("orders Default by effective path, then runtime start, then key — not by key or start alone", () => {
		const live = [pathFirstEarly(), pathFirstLate(), pathSecondEarliest()];
		for (const direction of ["asc", "desc"] as const) {
			for (const input of permutations(live)) {
				expect(keys(sortFleetRuntimes(input, [], { key: "default", direction }))).toEqual([
					"ffffffffffff",
					"000000000000",
					"888888888888",
				]);
			}
		}
	});

	it.each(["activity", "name", "created"] as const)(
		"breaks %s ties by path, then runtime start, in either direction",
		(key) => {
			const live = [pathFirstEarly(), pathFirstLate(), pathSecondEarliest()];
			for (const r of live) r.state.sessionName = "Equal";
			const inventory = live.map((r) => disk(r.key, { path: r.state.sessionFile!, created: day(2) }));
			for (const direction of ["asc", "desc"] as const) {
				for (const input of permutations(live)) {
					expect(keys(sortFleetRuntimes(input, inventory, { key, direction }))).toEqual([
						"ffffffffffff",
						"000000000000",
						"888888888888",
					]);
				}
			}
		},
	);

	it("breaks Runtime started ties by path and Project path ties by runtime start, in either direction", () => {
		const sameStartA = runtime("ffffffffffff", { cwd: "/a", createdAt: day(2) });
		const sameStartB = runtime("000000000000", { cwd: "/b", createdAt: day(2) });
		for (const direction of ["asc", "desc"] as const) {
			expect(keys(sortFleetRuntimes([sameStartB, sameStartA], [], { key: "started", direction }))).toEqual([
				"ffffffffffff",
				"000000000000",
			]);
			expect(keys(sortFleetRuntimes([pathFirstLate(), pathFirstEarly()], [], { key: "path", direction }))).toEqual([
				"ffffffffffff",
				"000000000000",
			]);
		}
	});

	it.each(FLEET_SORT_OPTIONS.map(({ key }) => key))(
		"uses fixed identity ties for %s, not input order or direction",
		(key) => {
			const tied = ["c", "a", "b"].map((key) => {
				const r = runtime(key, { cwd: "/same" });
				r.state.sessionName = "Equal";
				return r;
			});
			for (const direction of ["asc", "desc"] as const) {
				for (const input of [tied, [...tied].reverse(), [tied[1], tied[0], tied[2]]]) {
					expect(
						keys(
							sortFleetRuntimes(
								input,
								metadata.map((s) => ({ ...s, created: day(1) })),
								{ key, direction },
							),
						),
					).toEqual(["a", "b", "c"]);
				}
			}
		},
	);

	it.each(["activity", "created", "started"] as const)(
		"keeps unknown/invalid %s after all known dates in either direction",
		(key) => {
			const invalid = runtime("invalid", { createdAt: "bad", lastActivity: "" });
			const missing = runtime("missing", { createdAt: "", lastActivity: "bad" });
			missing.state.sessionFile = undefined;
			const inventory = [...metadata, disk("invalid", { created: "not a date" })];
			for (const direction of ["asc", "desc"] as const) {
				const ordered = sortFleetRuntimes([missing, invalid, ...live], inventory, { key, direction });
				expect(keys(ordered).slice(-2)).toEqual(["invalid", "missing"]);
				expect(keys(ordered).slice(0, 3).sort()).toEqual(["a", "b", "c"]);
			}
		},
	);

	it("uses only matching file identity for original creation and resolves late metadata without substituting start", () => {
		const old = runtime("old", { cwd: "/moved", createdAt: day(30) });
		const unknown = runtime("unknown", { cwd: "/same", createdAt: day(1) });
		unknown.state.sessionId = "old-session";
		const inventory = [
			disk("old", { cwd: "/historical", created: day(10) }),
			disk("unrelated", { cwd: "/same", created: day(1) }),
		];
		expect(keys(sortFleetRuntimes([unknown, old], inventory, { key: "created", direction: "asc" }))).toEqual([
			"old",
			"unknown",
		]);
		expect(
			keys(
				sortFleetRuntimes([unknown, old], [...inventory, disk("unknown", { created: day(2) })], {
					key: "created",
					direction: "asc",
				}),
			),
		).toEqual(["unknown", "old"]);
	});

	it("recognizes epoch dates and orders live effective paths rather than historical metadata paths", () => {
		const epoch = runtime("epoch", { cwd: "/z", createdAt: new Date(0).toISOString() });
		const later = runtime("later", { cwd: "/a" });
		expect(keys(sortFleetRuntimes([later, epoch], [], { key: "started", direction: "asc" }))).toEqual([
			"epoch",
			"later",
		]);
		expect(
			keys(
				sortFleetRuntimes([epoch, later], [disk("epoch", { cwd: "/a" }), disk("later", { cwd: "/z" })], {
					key: "path",
					direction: "asc",
				}),
			),
		).toEqual(["later", "epoch"]);
	});

	it("sorts by the actual locally updated name and case-insensitive fallback without changing names", () => {
		expect(
			keys(
				sortFleetRuntimes(live, metadata, { key: "name", direction: "asc" }, (r) =>
					runtimeDisplayName(r, r.key === "a" ? "Aardvark" : undefined),
				),
			),
		).toEqual(["a", "b", "c"]);
		const unnamed = runtime("fallback");
		unnamed.state.sessionName = undefined;
		expect(runtimeDisplayName(unnamed)).toBe("fallback");
		expect(runtimeDisplayName(unnamed, "")).toBe("");
		expect(runtimeDisplayName(unnamed, "Local")).toBe("Local");
		const upper = runtime("a");
		upper.state.sessionName = "SAME";
		const lower = runtime("b");
		lower.state.sessionName = "same";
		for (const direction of ["asc", "desc"] as const)
			expect(keys(sortFleetRuntimes([lower, upper], [], { key: "name", direction }))).toEqual(["a", "b"]);
	});

	it("does not mutate runtime/inventory arrays or DTOs for any key", () => {
		const before = JSON.stringify({ live, metadata });
		for (const { key } of FLEET_SORT_OPTIONS)
			sortFleetRuntimes(Object.freeze([...live]), Object.freeze([...metadata]), { key, direction: "desc" });
		expect(JSON.stringify({ live, metadata })).toBe(before);
	});
});

const past = [
	disk("a1", { cwd: "/a", name: "Zebra", created: day(2), modified: day(4) }),
	disk("a2", { cwd: "/a", name: "Apple", created: day(5), modified: day(1) }),
	disk("b1", { cwd: "/b", name: "Beta", created: day(1), modified: day(5) }),
	disk("b2", { cwd: "/b", name: "Yak", created: day(4), modified: day(2) }),
];

describe("Fleet historical group ordering", () => {
	it.each([
		[
			"default",
			"asc",
			[
				["/b", ["b1", "b2"]],
				["/a", ["a1", "a2"]],
			],
		],
		[
			"activity",
			"asc",
			[
				["/a", ["a2", "a1"]],
				["/b", ["b2", "b1"]],
			],
		],
		[
			"activity",
			"desc",
			[
				["/b", ["b1", "b2"]],
				["/a", ["a1", "a2"]],
			],
		],
		[
			"created",
			"asc",
			[
				["/b", ["b1", "b2"]],
				["/a", ["a1", "a2"]],
			],
		],
		[
			"created",
			"desc",
			[
				["/a", ["a2", "a1"]],
				["/b", ["b2", "b1"]],
			],
		],
		[
			"name",
			"asc",
			[
				["/a", ["a2", "a1"]],
				["/b", ["b1", "b2"]],
			],
		],
		[
			"name",
			"desc",
			[
				["/a", ["a1", "a2"]],
				["/b", ["b2", "b1"]],
			],
		],
		[
			"path",
			"asc",
			[
				["/a", ["a1", "a2"]],
				["/b", ["b1", "b2"]],
			],
		],
		[
			"path",
			"desc",
			[
				["/b", ["b1", "b2"]],
				["/a", ["a1", "a2"]],
			],
		],
	] as const)("sorts complete rows and leading-member groups by %s %s", (key, direction, expected) => {
		expect(groups([...past].reverse(), key, direction)).toEqual(expected);
	});

	it.each(["asc", "desc"] as const)(
		"leaves past sessions newest first for live-only runtime start %s",
		(direction) => {
			expect(groups(past, "started", direction)).toEqual(groups(past, "default"));
			expect(groups(past, "default", direction)).toEqual(groups(past, "default"));
		},
	);

	it.each(["asc", "desc"] as const)("keeps equal/missing group and row values deterministic in %s", (direction) => {
		const tied = [
			disk("z", { cwd: "/b", modified: "bad" }),
			disk("b", { cwd: "/a", modified: "" }),
			disk("a", { cwd: "/a", modified: "bad" }),
			disk("known", { cwd: "/z" }),
		];
		const expected = [
			["/z", ["known"]],
			["/a", ["a", "b"]],
			["/b", ["z"]],
		];
		expect(groups(tied, "activity", direction)).toEqual(expected);
		expect(groups([...tied].reverse(), "activity", direction)).toEqual(expected);
	});

	it("folds /tmp for display, excludes only exact live file matches, and preserves historical CWD", () => {
		const r = runtime("a1", { cwd: "/runtime" });
		const input = [
			past[0],
			disk("tmp1", { cwd: "/tmp/a" }),
			disk("tmp2", { cwd: "/tmp/b" }),
			disk("other", { cwd: "/runtime", id: "a1" }),
		];
		const result = sortFleetDiskGroups(input, [r], { key: "path", direction: "asc" });
		expect(result.map(([project]) => project)).toEqual(["/runtime", "/tmp"]);
		expect(result[1][1].map((s) => s.cwd)).toEqual(["/tmp/a", "/tmp/b"]);
		expect(fleetGroupKey("/tmpish/a")).toBe("/tmpish/a");
		expect(fleetGroupKey("")).toBe("");
	});

	it("uses the displayed first-message fallback for unnamed rows, including long previews", () => {
		const unnamed = disk("unnamed", { name: undefined, firstMessage: "a".repeat(90) });
		expect(diskSessionDisplayName(unnamed)).toBe(`“${"a".repeat(60)}…”`);
		const named = disk("named", { name: diskSessionDisplayName(unnamed) });
		for (const direction of ["asc", "desc"] as const)
			expect(groups([unnamed, named], "name", direction)).toEqual([["/repo", ["named", "unnamed"]]]);
	});

	it("handles empty inputs and never mutates inventory or live state", () => {
		expect(sortFleetDiskGroups([], [], DEFAULT_FLEET_SORT)).toEqual([]);
		expect(sortFleetRuntimes([], [], DEFAULT_FLEET_SORT)).toEqual([]);
		const before = JSON.stringify(past);
		for (const { key } of FLEET_SORT_OPTIONS)
			sortFleetDiskGroups(Object.freeze([...past]), Object.freeze([...live]), { key, direction: "desc" });
		expect(JSON.stringify(past)).toBe(before);
	});

	it("validates the complete preference and identifies only date keys", () => {
		expect(FLEET_SORT_OPTIONS.filter(({ key }) => isFleetDateSort(key)).map(({ key }) => key)).toEqual([
			"activity",
			"created",
			"started",
		]);
		for (const value of [
			null,
			[],
			{},
			"name",
			{ key: "name", direction: "up" },
			{ key: "unknown", direction: "asc" },
		])
			expect(normalizeFleetSort(value)).toEqual(DEFAULT_FLEET_SORT);
	});
});
