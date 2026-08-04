import type { CommandDto } from "../shared/protocol.js";

export interface ParsedDashboardBuiltin {
	command: CommandDto & { source: "builtin" };
	args: string;
}

export type DashboardBuiltinHandler = (args: string) => void | Promise<void>;

export function parseDashboardBuiltin(
	text: string,
	commands: readonly CommandDto[],
): ParsedDashboardBuiltin | undefined {
	const trimmed = text.trim();
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return undefined;
	const command = commands.find(
		(candidate): candidate is CommandDto & { source: "builtin" } =>
			candidate.source === "builtin" && candidate.name === match[1],
	);
	if (!command) return undefined;
	return { command, args: (match[2] ?? "").trim() };
}

export async function dispatchBuiltinCommand(
	parsed: ParsedDashboardBuiltin,
	handlers: Readonly<Record<string, DashboardBuiltinHandler>>,
	notice: (message: string) => void,
): Promise<void> {
	const handler = handlers[parsed.command.name];
	if (handler) {
		await handler(parsed.args);
		return;
	}
	if (parsed.command.dashboard === false) {
		notice(`/${parsed.command.name} is available only in the terminal UI.`);
		return;
	}
	notice(`/${parsed.command.name} isn't implemented in the dashboard yet — use the terminal UI.`);
}

/**
 * Deduplicate by name (built-ins win collisions), then rank autocomplete.
 * A bare slash preserves existing resource suggestions ahead of built-ins;
 * typed queries rank prefix matches ahead of substring matches.
 */
export function commandMatches(commands: readonly CommandDto[], query: string, limit = 8): CommandDto[] {
	const byName = new Map<string, CommandDto>();
	for (const command of commands) {
		const existing = byName.get(command.name);
		if (!existing || command.source === "builtin") byName.set(command.name, command);
	}
	return [...byName.values()]
		.filter((command) => command.source !== "builtin" || command.dashboard !== false)
		.filter((command) => {
			const name = command.name.toLowerCase();
			return !query || name.startsWith(query) || name.includes(query);
		})
		.sort((a, b) => {
			const aName = a.name.toLowerCase();
			const bName = b.name.toLowerCase();
			const aMatch = query ? (aName.startsWith(query) ? 0 : 1) : a.source === "builtin" ? 1 : 0;
			const bMatch = query ? (bName.startsWith(query) ? 0 : 1) : b.source === "builtin" ? 1 : 0;
			return aMatch - bMatch || a.name.localeCompare(b.name);
		})
		.slice(0, limit);
}
