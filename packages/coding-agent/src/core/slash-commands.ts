import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	/** Whether the command is offered in dashboard autocomplete. Typed built-ins are always intercepted. */
	dashboard?: false;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "copy", description: "Copy last agent message to clipboard", dashboard: false },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", dashboard: false },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "dream", description: "Consolidate and prune memories (backup, merge, scan sessions)" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{
		name: "buddy",
		description: "Hatch or manage your terminal companion (pet, reroll, off)",
		dashboard: false,
	},
	{ name: "quit", description: "Quit dreb" },
];

const BUILTIN_BY_NAME = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));

/**
 * Parse a registered built-in from the first slash token.
 *
 * `/fork` and `/fork anything` match while `/forklift` and unknown slash
 * commands do not. Leading/trailing whitespace follows interactive-mode submit
 * behavior. Hidden development commands are intentionally absent from the
 * registry and therefore never match.
 */
export function parseBuiltinSlashCommand(text: string): { command: BuiltinSlashCommand; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return undefined;
	const command = BUILTIN_BY_NAME.get(match[1]);
	if (!command) return undefined;
	return { command, args: (match[2] ?? "").trim() };
}
