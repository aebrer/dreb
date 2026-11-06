/** Fleet-only presentation ordering. No store mutation, storage, or network I/O. */
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";

export const FLEET_SORT_OPTIONS = [
	{ key: "default", label: "Default" },
	{ key: "activity", label: "Last activity" },
	{ key: "created", label: "Session created" },
	{ key: "started", label: "Runtime started (live only)" },
	{ key: "name", label: "Session name" },
	{ key: "path", label: "Project path" },
] as const;

export type FleetSortKey = (typeof FLEET_SORT_OPTIONS)[number]["key"];
export type FleetSortDirection = "asc" | "desc";
export interface FleetSortPreference {
	readonly key: FleetSortKey;
	readonly direction: FleetSortDirection;
}

export const DEFAULT_FLEET_SORT: FleetSortPreference = Object.freeze({ key: "default", direction: "asc" });

export function normalizeFleetSort(value: unknown): FleetSortPreference {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { key, direction } = value as Record<string, unknown>;
		if (FLEET_SORT_OPTIONS.some((option) => option.key === key) && (direction === "asc" || direction === "desc")) {
			return { key: key as FleetSortKey, direction };
		}
	}
	return DEFAULT_FLEET_SORT;
}

export function isFleetDateSort(key: FleetSortKey): boolean {
	return key === "activity" || key === "created" || key === "started";
}

/** The same visible names are used for presentation and name sorting, including explicit empty names. */
export function runtimeDisplayName(runtime: RuntimeInfoDto, localName?: string): string {
	return localName ?? runtime.state.sessionName ?? runtime.state.sessionId.slice(0, 8);
}

export function diskSessionDisplayName(session: SessionInfoDto): string {
	return session.name ?? `“${session.firstMessage.slice(0, 60)}…”`;
}

/** Display grouping only: operational CWD and session paths are never rewritten. */
export function fleetGroupKey(cwd: string): string {
	return cwd === "/tmp" || cwd.startsWith("/tmp/") ? "/tmp" : cwd;
}

type SortValue = number | string | undefined;
const textOrder = new Intl.Collator(undefined, { sensitivity: "accent" });

function timestamp(value: string | undefined): number | undefined {
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Unknown dates/paths stay last in BOTH directions. Only known primary values reverse. */
function compareValues(a: SortValue, b: SortValue, direction: FleetSortDirection): number {
	if (a === undefined) return b === undefined ? 0 : 1;
	if (b === undefined) return -1;
	const result = typeof a === "number" && typeof b === "number" ? a - b : textOrder.compare(String(a), String(b));
	return direction === "asc" ? result : -result;
}

// Unlike collation, raw identity comparison distinguishes every different string.
function identityOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function stableRuntimeOrder(a: RuntimeInfoDto, b: RuntimeInfoDto): number {
	return (
		a.cwd.localeCompare(b.cwd) ||
		compareValues(timestamp(a.createdAt), timestamp(b.createdAt), "asc") ||
		identityOrder(a.key, b.key)
	);
}

// Metadata may still be loading, and a new session's file exists only after its first
// assistant reply. Match exact file identity, never CWD/name/session ID, and never
// silently replace original creation with the current runtime's start.
function originalCreation(inventory: readonly SessionInfoDto[]): (runtime: RuntimeInfoDto) => number | undefined {
	const createdByFile = new Map(inventory.map((session) => [session.path, timestamp(session.created)] as const));
	return (runtime) => (runtime.state.sessionFile ? createdByFile.get(runtime.state.sessionFile) : undefined);
}

/** Live runtimes that "Session created" must list last because no saved creation date matches them. */
export function countUnknownOriginalCreation(
	runtimes: readonly RuntimeInfoDto[],
	inventory: readonly SessionInfoDto[],
): number {
	const created = originalCreation(inventory);
	return runtimes.filter((runtime) => created(runtime) === undefined).length;
}

export function sortFleetRuntimes(
	runtimes: readonly RuntimeInfoDto[],
	inventory: readonly SessionInfoDto[],
	sort: FleetSortPreference,
	name: (runtime: RuntimeInfoDto) => string = runtimeDisplayName,
): RuntimeInfoDto[] {
	const created = sort.key === "created" ? originalCreation(inventory) : () => undefined;
	const value = (runtime: RuntimeInfoDto): SortValue => {
		switch (sort.key) {
			case "activity":
				return timestamp(runtime.lastActivity);
			case "created":
				return created(runtime);
			case "started":
				return timestamp(runtime.createdAt);
			case "name":
				return name(runtime);
			case "path":
				return runtime.cwd || undefined;
			default:
				return undefined;
		}
	};
	return runtimes
		.map((runtime) => ({ runtime, value: value(runtime) }))
		.sort((a, b) => compareValues(a.value, b.value, sort.direction) || stableRuntimeOrder(a.runtime, b.runtime))
		.map(({ runtime }) => runtime);
}

export type FleetDiskGroup = [project: string, sessions: SessionInfoDto[]];

export function sortFleetDiskGroups(
	inventory: readonly SessionInfoDto[],
	runtimes: readonly RuntimeInfoDto[],
	preference: FleetSortPreference,
): FleetDiskGroup[] {
	// Past sessions do not have a current runtime start. Keep their usual presentation
	// in this explicitly live-only mode, independently of its selected direction.
	const sort: FleetSortPreference =
		preference.key === "default" || preference.key === "started"
			? { key: "activity", direction: "desc" }
			: preference;
	const value = (session: SessionInfoDto): SortValue => {
		switch (sort.key) {
			case "created":
				return timestamp(session.created);
			case "name":
				return diskSessionDisplayName(session);
			case "path":
				return session.cwd || undefined;
			default:
				return timestamp(session.modified);
		}
	};
	const liveFiles = new Set(runtimes.map((runtime) => runtime.state.sessionFile).filter(Boolean));
	const groups = new Map<string, SessionInfoDto[]>();
	for (const session of inventory) {
		if (liveFiles.has(session.path)) continue;
		const project = fleetGroupKey(session.cwd);
		const group = groups.get(project) ?? [];
		group.push(session);
		groups.set(project, group);
	}
	return [...groups.entries()]
		.map(([project, sessions]) => {
			const ordered = sessions
				.map((session) => ({ session, value: value(session) }))
				.sort(
					(a, b) =>
						compareValues(a.value, b.value, sort.direction) ||
						identityOrder(a.session.path, b.session.path) ||
						identityOrder(a.session.id, b.session.id),
				);
			return { project, sessions: ordered.map(({ session }) => session), value: ordered[0]?.value };
		})
		.sort((a, b) => compareValues(a.value, b.value, sort.direction) || identityOrder(a.project, b.project))
		.map(({ project, sessions }): FleetDiskGroup => [project, sessions]);
}
