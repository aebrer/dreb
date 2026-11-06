/** Screen-local Fleet filtering. No mutation, storage, or network I/O. */
import type { RuntimeInfoDto, SessionInfoDto } from "../../shared/protocol.js";
import { diskSessionDisplayName, runtimeDisplayName } from "./fleet-sorting.js";

export function normalizeFleetQuery(query: string): string {
	return query.trim().toLowerCase();
}

export function fleetDisplayPath(cwd: string): string {
	return cwd.replace(/^\/home\/[^/]+/, "~");
}

function matchesPath(cwd: string, query: string): boolean {
	return cwd.toLowerCase().includes(query) || fleetDisplayPath(cwd).toLowerCase().includes(query);
}

export function filterFleetRuntimes(
	runtimes: readonly RuntimeInfoDto[],
	query: string,
	attentionOnly: boolean,
	localName: (runtime: RuntimeInfoDto) => string | undefined = () => undefined,
): RuntimeInfoDto[] {
	const normalized = normalizeFleetQuery(query);
	return runtimes.filter(
		(runtime) =>
			(!attentionOnly || runtime.needsAttention) &&
			(!normalized ||
				runtimeDisplayName(runtime, localName(runtime)).toLowerCase().includes(normalized) ||
				matchesPath(runtime.cwd, normalized)),
	);
}

/** Search historical CWD, never its canonical resume target or opaque session-file path. */
export function filterFleetDiskSessions(inventory: readonly SessionInfoDto[], query: string): SessionInfoDto[] {
	const normalized = normalizeFleetQuery(query);
	return inventory.filter(
		(session) =>
			!normalized ||
			diskSessionDisplayName(session).toLowerCase().includes(normalized) ||
			matchesPath(session.cwd, normalized),
	);
}
