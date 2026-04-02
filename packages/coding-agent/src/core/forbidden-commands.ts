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
 *
 * To avoid false positives from operators inside quoted strings, content
 * within single/double quotes is masked before splitting. To catch subshell
 * wrappers like $(cmd) and (cmd), leading wrapper characters are stripped
 * from each segment before pattern matching.
 */

/** Hardcoded patterns that are always active. Always anchored with ^. */
const DEFAULT_FORBIDDEN_PATTERNS: string[] = [
	"^gh pr merge.*--admin", // bypass branch protection
	"^git push.*(-f\\b|--force)", // force push (includes --force-with-lease)
	"^gh api.*bypass", // API calls with bypass flag
	"HUSKY=0", // bypass pre-commit hooks
];

/**
 * Mask content inside single and double-quoted strings by replacing
 * characters within quotes with underscores. This prevents shell operators
 * inside quoted strings from causing false splits.
 *
 * Handles escaped quotes (\", \') within strings. Correctly counts
 * consecutive backslashes before a quote — an even count means the quote
 * is real (e.g. `\\"` is escaped-backslash + closing quote).
 */
function maskQuotedContent(command: string): string {
	let result = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (ch === "'" && !inDouble) {
			if (!isEscaped(command, i)) {
				inSingle = !inSingle;
			}
			result += ch;
		} else if (ch === '"' && !inSingle) {
			if (!isEscaped(command, i)) {
				inDouble = !inDouble;
			}
			result += ch;
		} else if (inSingle || inDouble) {
			// Replace content inside quotes with a safe character
			// that won't match shell operators
			result += ch === "\n" ? "\n" : "_";
		} else {
			result += ch;
		}
	}

	return result;
}

/**
 * Check if the character at position `i` is escaped by counting consecutive
 * trailing backslashes. If the count is odd, the character is escaped.
 * If even (including zero), it is not escaped.
 *
 * e.g. `\\"` → 2 backslashes → even → `"` is NOT escaped (real quote)
 *      `\\\"` → 3 backslashes → odd → `"` IS escaped (literal quote)
 */
function isEscaped(str: string, i: number): boolean {
	let count = 0;
	let j = i - 1;
	while (j >= 0 && str[j] === "\\") {
		count++;
		j--;
	}
	return count % 2 === 1;
}

/**
 * Split a command string into individual segments on shell operators.
 *
 * Handles: &&, ||, ;, |, & (background), and newlines.
 * Content inside single/double quotes is masked before splitting so that
 * operators inside quoted strings don't cause false splits.
 * Each segment is trimmed of leading whitespace.
 */
function splitCommandSegments(command: string): string[] {
	// Mask quoted content to avoid splitting on operators inside strings
	const masked = maskQuotedContent(command);

	// Split on shell operators: &&, ||, ;, |, &, and newlines
	const splits = masked.split(/\s*(?:&&|\|\||[;&|]|\n)\s*/);

	// Map split positions back to original command segments.
	// We split the masked string to find operator positions, but return
	// the original (unmasked) segments so pattern matching sees real text.
	const originalSegments: string[] = [];
	let maskedIdx = 0;

	for (const part of splits) {
		// Find the start of this part in the masked string
		const startInMasked = masked.indexOf(part, maskedIdx);
		if (startInMasked === -1) {
			// Fallback: use the part as-is (shouldn't happen)
			originalSegments.push(command.substring(maskedIdx, maskedIdx + part.length).trim());
		} else {
			originalSegments.push(command.substring(startInMasked, startInMasked + part.length).trim());
		}
		maskedIdx = startInMasked + part.length;
	}

	return originalSegments.filter((s) => s.length > 0);
}

/**
 * Strip leading subshell/command-substitution wrappers from a segment
 * so that $(cmd), (cmd), and `cmd` are checked against patterns too.
 *
 * Handles both full-segment wrappers ($(cmd)) and inline substitutions
 * (result=$(cmd)) by extracting inner commands.
 */
function stripSubshellWrapper(segment: string): string {
	// Strip $(...) wrapper when it's the whole segment
	if (/^\$\(/.test(segment) && segment.endsWith(")")) {
		return segment.slice(2, -1).trim();
	}
	// Strip (...) wrapper (subshell) when it's the whole segment
	if (/^\(/.test(segment) && segment.endsWith(")")) {
		return segment.slice(1, -1).trim();
	}
	// Strip backtick wrapper when it's the whole segment
	if (/^`/.test(segment) && segment.endsWith("`")) {
		return segment.slice(1, -1).trim();
	}
	// Extract inner command from inline $() or backtick substitutions
	// e.g., "result=$(git push --force)" → "git push --force"
	const inlineMatch = segment.match(/\$\(([^)]+)\)/);
	if (inlineMatch) {
		return inlineMatch[1].trim();
	}
	const backtickMatch = segment.match(/`([^`]+)`/);
	if (backtickMatch) {
		return backtickMatch[1].trim();
	}
	return segment;
}

/**
 * Check whether a command matches any forbidden pattern.
 *
 * The command is split on shell operators (&&, ||, ;, |) with quoted content
 * masked to avoid false splits. Each segment is then stripped of subshell
 * wrappers ($(...), (...), `...`) and checked against patterns. Default
 * patterns are ^-anchored so they only match commands that start with the
 * dangerous command prefix.
 *
 * @returns The first matching pattern, or `undefined` if the command is allowed.
 */
export function isForbiddenCommand(command: string, extraPatterns?: string[]): string | undefined {
	// Guard against misconfigured settings (string instead of array)
	const validatedExtras = Array.isArray(extraPatterns) ? extraPatterns : undefined;
	const allPatterns = validatedExtras
		? [...DEFAULT_FORBIDDEN_PATTERNS, ...validatedExtras]
		: DEFAULT_FORBIDDEN_PATTERNS;
	const segments = splitCommandSegments(command);

	for (const segment of segments) {
		// Check both the raw segment and the subshell-unwrapped version
		const toCheck = [segment, stripSubshellWrapper(segment)];
		for (const text of toCheck) {
			for (const pattern of allPatterns) {
				try {
					const re = new RegExp(pattern);
					if (re.test(text)) {
						return pattern;
					}
				} catch {
					// Invalid regex in user settings — skip it
				}
			}
		}
	}

	return undefined;
}
