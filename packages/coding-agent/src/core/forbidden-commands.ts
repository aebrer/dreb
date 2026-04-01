/**
 * Forbidden-commands guard — blocks bash commands matching dangerous patterns
 * before they reach the shell.
 *
 * Hardcoded default patterns are ALWAYS active regardless of settings.
 * Users can add additional patterns via settings.forbiddenCommands.
 */

/** Hardcoded patterns that are always active. */
const DEFAULT_FORBIDDEN_PATTERNS: string[] = [
	"gh pr merge.*--admin", // bypass branch protection
	"git push.*(-f\\b|--force)", // force push (includes --force-with-lease)
	"gh api.*bypass", // API calls with bypass flag
];

/**
 * Check whether a command matches any forbidden pattern.
 *
 * @returns The first matching pattern, or `undefined` if the command is allowed.
 */
export function isForbiddenCommand(command: string, extraPatterns?: string[]): string | undefined {
	const allPatterns = extraPatterns ? [...DEFAULT_FORBIDDEN_PATTERNS, ...extraPatterns] : DEFAULT_FORBIDDEN_PATTERNS;

	for (const pattern of allPatterns) {
		try {
			const re = new RegExp(pattern);
			if (re.test(command)) {
				return pattern;
			}
		} catch {
			// Invalid regex in user settings — skip it
		}
	}

	return undefined;
}
