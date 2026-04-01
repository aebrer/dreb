/**
 * Forbidden-commands guard — blocks bash commands matching dangerous patterns
 * before they reach the shell.
 *
 * Hardcoded default patterns are ALWAYS active regardless of settings.
 * Users can add additional patterns via settings.forbiddenCommands.
 *
 * Commands are split on shell operators (&&, ||, ;, |, &) and each segment
 * is checked independently. Default patterns are anchored to the start of
 * each segment (^) so they only match commands that *begin with* the dangerous
 * command, not commands that merely *mention* the pattern in string literals
 * or arguments.
 */

/** Hardcoded patterns that are always active. Always anchored with ^. */
const DEFAULT_FORBIDDEN_PATTERNS: string[] = [
	"^gh pr merge.*--admin", // bypass branch protection
	"^git push.*(-f\\b|--force)", // force push (includes --force-with-lease)
	"^gh api.*bypass", // API calls with bypass flag
];

/**
 * Split a command string into individual segments on shell operators.
 *
 * Handles: &&, ||, ;, |, & (background), and newlines.
 * Each segment is trimmed of leading whitespace.
 */
function splitCommandSegments(command: string): string[] {
	// Split on shell operators: &&, ||, ;, |, &, and newlines
	// The regex captures the operator so we can split around it
	const segments = command.split(/\s*(?:&&|\|\||[;&|]|\n)\s*/);
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Check whether a command matches any forbidden pattern.
 *
 * The command is split on shell operators (&&, ||, ;, |) and each segment
 * is checked independently. Default patterns are ^-anchored so they only
 * match commands that start with the dangerous command prefix.
 *
 * @returns The first matching pattern, or `undefined` if the command is allowed.
 */
export function isForbiddenCommand(command: string, extraPatterns?: string[]): string | undefined {
	const allPatterns = extraPatterns ? [...DEFAULT_FORBIDDEN_PATTERNS, ...extraPatterns] : DEFAULT_FORBIDDEN_PATTERNS;
	const segments = splitCommandSegments(command);

	for (const segment of segments) {
		for (const pattern of allPatterns) {
			try {
				const re = new RegExp(pattern);
				if (re.test(segment)) {
					return pattern;
				}
			} catch {
				// Invalid regex in user settings — skip it
			}
		}
	}

	return undefined;
}
