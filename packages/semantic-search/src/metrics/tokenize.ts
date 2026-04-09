/**
 * Shared tokenizer for path-match and symbol-match metrics.
 *
 * Splits text on common code boundaries (spaces, path separators, dots,
 * dashes, underscores, camelCase) and normalizes to lowercase.
 */

/**
 * Tokenize text by splitting on spaces, `/`, `\`, `.`, `-`, `_`, and
 * camelCase boundaries. Returns unique, lowercase tokens ≥ 2 chars.
 */
export function tokenize(text: string): string[] {
	// Insert a space before uppercase letters that follow lowercase letters (camelCase)
	// or before uppercase letters followed by lowercase (e.g., "XMLParser" → "XML Parser")
	const spaced = text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

	// Split on common delimiters
	const parts = spaced.split(/[\s/\\.\-_]+/);

	// Lowercase, deduplicate, filter short tokens
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const part of parts) {
		const lower = part.toLowerCase();
		if (lower.length >= 2 && !seen.has(lower)) {
			seen.add(lower);
			tokens.push(lower);
		}
	}

	return tokens;
}
