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
	"^(?:export\\s+)?HUSKY=0", // bypass pre-commit hooks (anchored with optional export prefix)
	"^git\\s+commit.*--no-verify", // bypass pre-commit hooks via --no-verify flag
	"^(?:export\\s+)?SKIP_?VALIDATION=1", // bypass pre-commit hooks via SKIP_VALIDATION env var
	"^rm\\s+.*--no-preserve-root", // rm with explicit safety override
	"^rm\\s+.*\\s[\"']?/(\\*|[\\w.-]+/?)?[\"']?(\\s|$)", // rm targeting root or top-level dirs (/, /*, /home, /etc)
	"^dd\\s+.*of=/dev/(sd|hd|vd|nvme|xvd|loop|mmcblk|disk)", // dd writing to block devices
	"^mkfs", // format filesystem (mkfs.ext4, mkfs.xfs, etc.)
	"^>>?\\s*/dev/(sd|hd|vd|nvme|xvd|loop|mmcblk|disk)", // redirect to block device (> and >>)
];

/**
 * Patterns checked against the full (quote-masked) command string before
 * splitting into segments. These catch dangerous constructs that span
 * shell operators and would be fragmented by the segment splitter.
 *
 * Matched against the masked string so quoted content doesn't trigger
 * false positives (e.g., `echo ":(){ :|:& };:"` is safe).
 */
const FULL_COMMAND_PATTERNS: string[] = [
	":\\(\\)\\s*\\{", // fork bomb :(){ :|:& };:
];

/**
 * Patterns also checked against content extracted from within quoted strings.
 * Catches commands like `echo "rm -rf /"` where the quoted content is a
 * destructive command that could be piped to execution via `| bash`.
 *
 * These are intentionally limited to destructive/dangerous patterns — env var
 * patterns like HUSKY=0 are excluded because they appear legitimately in
 * contexts like `git log --grep="HUSKY=0"`.
 *
 * The fork bomb pattern from FULL_COMMAND_PATTERNS is included here because
 * it also needs to be caught when quoted (e.g., `echo ":(){ :|:& };:"`).
 */
const QUOTED_CONTENT_PATTERNS: string[] = [
	"^rm\\s+.*--no-preserve-root",
	"^rm\\s+.*\\s/(\\*|[\\w.-]+/?)?(\\s|$)",
	"^dd\\s+.*of=/dev/(sd|hd|vd|nvme|xvd|loop|mmcblk|disk)",
	"^mkfs",
	"^>>?\\s*/dev/(sd|hd|vd|nvme|xvd|loop|mmcblk|disk)",
	"^gh pr merge.*--admin",
	"^git push.*(-f\\b|--force)",
	"^gh api.*bypass",
	"^git\\s+commit.*--no-verify",
	":\\(\\)\\s*\\{", // fork bomb
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
			// In bash, single-quoted strings are completely literal — backslashes
			// have no escape function inside single quotes. Always toggle.
			inSingle = !inSingle;
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
 * Extract text content from within quoted strings in a segment.
 * Used to catch commands like `echo "rm -rf /" | bash` where dangerous
 * content is hidden inside quotes. The normal segment check won't catch
 * this because `echo` (not `rm`) starts the segment. By extracting the
 * quoted content and checking it separately, we block segments that
 * contain forbidden commands in their quoted arguments.
 */
function extractQuotedContent(text: string): string[] {
	const results: string[] = [];
	let inQuote: string | null = null;
	let start = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if ((ch === '"' || ch === "'") && (ch === "'" || !isEscaped(text, i))) {
			if (inQuote === null) {
				inQuote = ch;
				start = i + 1;
			} else if (ch === inQuote) {
				const content = text.substring(start, i).trim();
				if (content.length > 0) {
					results.push(content);
				}
				inQuote = null;
			}
		}
	}
	return results;
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

	// Pre-split check: match full-command patterns against the quote-masked
	// string to catch constructs that span shell operators (e.g., fork bombs).
	// Using the masked string prevents false positives from quoted content.
	const masked = maskQuotedContent(command);
	for (const pattern of FULL_COMMAND_PATTERNS) {
		try {
			const re = new RegExp(pattern);
			if (re.test(masked)) {
				return pattern;
			}
		} catch {
			// Invalid regex — skip
		}
	}

	const segments = splitCommandSegments(command);

	// Combine quoted-content patterns with any user extras for quoted checking
	const allQuotedPatterns = validatedExtras
		? [...QUOTED_CONTENT_PATTERNS, ...validatedExtras]
		: QUOTED_CONTENT_PATTERNS;

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

		// Check content within quotes for embedded dangerous commands.
		// There is no legitimate reason for an agent to output/echo forbidden
		// commands, and quoted content could be piped to execution via | bash.
		const quotedContent = extractQuotedContent(segment);
		for (const content of quotedContent) {
			for (const pattern of allQuotedPatterns) {
				try {
					const re = new RegExp(pattern);
					if (re.test(content)) {
						return pattern;
					}
				} catch {
					// Invalid regex — skip
				}
			}
		}
	}

	return undefined;
}

/**
 * Extract file paths from a command that executes a script file.
 * Detects: `bash file`, `sh file`, `source file`, `. file`, and input
 * redirects like `bash < file`.
 *
 * Returns an array of file paths (usually 0 or 1). Does not check whether
 * the files exist — the caller handles that.
 *
 * @returns Array of script file paths referenced by the command.
 */
export function extractScriptPaths(command: string): string[] {
	const paths: string[] = [];
	const segments = splitCommandSegments(command);

	for (const segment of segments) {
		const trimmed = segment.trim();

		// bash < file.sh (input redirect) — check before shell exec to avoid
		// the shell exec regex matching "<" as a filename
		const redirectMatch = trimmed.match(/^(?:bash|sh|zsh|ksh)(?:\s+-\S+)*\s+<\s*(\S+)/);
		if (redirectMatch?.[1]) {
			paths.push(redirectMatch[1]);
			continue;
		}

		// bash [flags] file.sh, sh [flags] file.sh
		// Flags are short options like -x, -e, -ex, etc.
		// Exclude -c (inline command — handled by quoted content check)
		if (/^(?:bash|sh|zsh|ksh)\s+-c\b/.test(trimmed)) {
			continue;
		}
		const shellExecMatch = trimmed.match(/^(?:bash|sh|zsh|ksh)\s+(?:-\S+\s+)*(\S+)/);
		if (shellExecMatch) {
			const filePath = shellExecMatch[1];
			if (filePath && !filePath.startsWith("-")) {
				paths.push(filePath);
			}
		}

		// source file.sh, . file.sh
		const sourceMatch = trimmed.match(/^(?:source|\.)\s+(\S+)/);
		if (sourceMatch?.[1]) {
			paths.push(sourceMatch[1]);
		}
	}

	return [...new Set(paths)]; // deduplicate
}

/**
 * Check file content line-by-line for forbidden commands.
 * Each non-empty, non-comment line is passed through `isForbiddenCommand`.
 *
 * This is a pure function — the caller is responsible for reading the file
 * and passing the content string.
 *
 * @returns The first match with pattern, line number, and line text, or undefined.
 */
export function checkScriptContent(
	content: string,
	extraPatterns?: string[],
): { pattern: string; line: number; text: string } | undefined {
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// Skip empty lines and comments
		if (!line || line.startsWith("#")) continue;

		const pattern = isForbiddenCommand(line, extraPatterns);
		if (pattern) {
			return { pattern, line: i + 1, text: line };
		}
	}

	return undefined;
}
