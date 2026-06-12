import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Parse a `/new` command path argument into an absolute path.
 *
 * Rules:
 * - Empty input is not handled here; callers should treat it as bare `/new`.
 * - Arguments that already look like explicit paths (start with `~` or `/`, or
 *   contain any `/`) are resolved as-is, expanding `~` to the user's home dir.
 * - Otherwise, whitespace-separated tokens are treated as shorthand path
 *   segments under `~`. Double-quoted spans are kept as a single segment,
 *   allowing directory names that contain spaces:
 *     `"My Projects" dreb` -> `~/My Projects/dreb`
 */
export function resolveNewPath(pathArg: string, getHome = homedir): string {
	const trimmed = pathArg.trim();

	if (!trimmed) {
		throw new Error("resolveNewPath does not handle bare /new; pass a non-empty path argument");
	}

	// Explicit path forms: keep existing behavior.
	if (trimmed.startsWith("~") || trimmed.startsWith("/") || trimmed.includes("/")) {
		const expanded = trimmed.startsWith("~") ? trimmed.replace("~", getHome()) : trimmed;
		return resolve(expanded);
	}

	// Shorthand form: tokens under the home directory.
	const segments = parseShorthandTokens(trimmed);
	if (segments.length === 0) {
		throw new Error("Invalid /new shorthand: no path segments were provided");
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new Error("Invalid /new shorthand: path segments cannot be '.' or '..'");
	}

	const homeRelative = ["~", ...segments].join("/");
	return resolve(homeRelative.replace("~", getHome()));
}

/**
 * Split shorthand input into path segments, respecting double-quoted spans.
 */
function parseShorthandTokens(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;

	for (const char of input) {
		if (char === '"') {
			inQuote = !inQuote;
		} else if (/\s/.test(char) && !inQuote) {
			if (current.trim().length > 0) {
				tokens.push(current);
			}
			current = "";
		} else {
			current += char;
		}
	}

	if (inQuote) {
		throw new Error("Invalid /new shorthand: missing closing quote");
	}

	if (current.trim().length > 0) {
		tokens.push(current);
	}

	return tokens;
}
