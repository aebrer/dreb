import type { Api, Model, StreamOptions } from "../types.js";

/**
 * HTTP header OpenCode uses for per-conversation routing and optimization.
 * Must be a stable identifier for the lifetime of one conversation (issue 500).
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** Provider IDs of the built-in OpenCode endpoints. */
const OPENCODE_PROVIDER_IDS = new Set(["opencode", "opencode-go"]);

/**
 * Returns true when the model points at an OpenCode endpoint: either one of the
 * built-in OpenCode providers, or a custom provider whose base URL parses to
 * exactly the `opencode.ai` hostname. Hostname equality is exact (case-insensitive,
 * no substring matching) so lookalike domains never receive session IDs.
 */
export function isOpenCodeModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
	if (OPENCODE_PROVIDER_IDS.has(model.provider)) {
		return true;
	}
	try {
		return new URL(model.baseUrl).hostname.toLowerCase() === "opencode.ai";
	} catch {
		return false;
	}
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
	if (!headers) return false;
	const wanted = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Returns options with `x-opencode-session` added for OpenCode models when a
 * session ID is present. The input is never mutated; a new options object is
 * returned when the header is added.
 *
 * Precedence: an explicit header in `model.headers` or `options.headers` wins
 * case-insensitively, so no differently-cased duplicate of the generated header
 * can be sent. OpenCode models without a session ID, missing options, and
 * non-OpenCode models are returned unchanged.
 */
export function withOpenCodeSessionHeader<TOptions extends StreamOptions | undefined>(
	model: Pick<Model<Api>, "provider" | "baseUrl" | "headers">,
	options: TOptions,
): TOptions {
	if (!options) return options;
	const sessionId = options.sessionId;
	if (!sessionId) return options;
	if (!isOpenCodeModel(model)) return options;
	if (hasHeader(model.headers, OPENCODE_SESSION_HEADER) || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) {
		return options;
	}
	return {
		...options,
		headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: sessionId },
	} as TOptions;
}
