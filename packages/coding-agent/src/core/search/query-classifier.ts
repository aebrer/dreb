/**
 * Classify search queries into types for POEM column weighting.
 *
 * Query types affect how metric columns are duplicated during ranking:
 * - identifier: emphasise BM25 and symbol-match scores
 * - path_like: emphasise path-match scores
 * - natural_language: emphasise cosine similarity scores
 */

export type QueryType = "identifier" | "natural_language" | "path_like";

/** Matches camelCase or PascalCase boundaries (lowercase→uppercase). */
const CAMEL_RE = /[a-z][A-Z]/;

/** Matches snake_case — word chars around an underscore. */
const SNAKE_RE = /\w+_\w+/;

/** SCREAMING_SNAKE_CASE — two or more uppercase-letter groups joined by underscores. */
const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Path separators. */
const PATH_SEP_RE = /[/\\]/;

/** Dotted path like `foo.bar.baz` (3+ segments). */
const DOTTED_PATH_RE = /^\w+\.\w+\.\w+/;

/** File extension pattern — ends with `.ext` where ext is 1-5 alphanumeric chars. */
const FILE_EXT_RE = /\.\w{1,5}$/;

/**
 * Classify a search query to guide POEM column weighting.
 *
 * @param query Raw user query string
 * @returns The detected query type
 */
export function classifyQuery(query: string): QueryType {
	const trimmed = query.trim();
	if (trimmed.length === 0) return "natural_language";

	// --- path_like ---
	if (PATH_SEP_RE.test(trimmed)) return "path_like";
	if (DOTTED_PATH_RE.test(trimmed)) return "path_like";
	// File extension at end of a single token (e.g. "config.yaml", "auth.ts")
	const words = trimmed.split(/\s+/);
	if (words.length === 1 && FILE_EXT_RE.test(trimmed) && /\./.test(trimmed)) {
		return "path_like";
	}

	// --- identifier ---
	// Single token or short (≤3 words) with code-style naming
	if (words.length === 1) return "identifier";
	if (words.length <= 3) {
		// If any word looks like a code identifier, classify as identifier
		if (words.some((w) => CAMEL_RE.test(w) || SNAKE_RE.test(w) || SCREAMING_SNAKE_RE.test(w))) {
			return "identifier";
		}
	}

	// --- natural_language ---
	return "natural_language";
}
