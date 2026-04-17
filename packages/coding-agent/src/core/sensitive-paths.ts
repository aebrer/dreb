import { homedir } from "node:os";
import { normalize, resolve } from "node:path";

export interface SensitivePathResult {
	blocked: boolean;
	pattern?: string;
}

export const DEFAULT_SENSITIVE_PATTERNS: string[] = [
	"~/.ssh/id_*",
	"~/.gnupg/private-keys-v1.d/*",
	"~/.dreb/secrets/*",
	"~/.dreb/agent/auth.json",
	"~/.aws/credentials",
	"~/.config/gcloud/credentials.db",
];

const SSH_PUB_SUFFIX = ".pub";

/**
 * Expand `~` or `~/` prefix to the user's home directory.
 */
function expandHome(filepath: string): string {
	if (filepath === "~") return homedir();
	if (filepath.startsWith("~/")) return `${homedir()}/${filepath.slice(2)}`;
	return filepath;
}

/**
 * Resolve and normalize a path, expanding `~` to the real home directory.
 * This defeats traversal attacks like `../../.ssh/id_rsa`.
 */
function resolvePath(filepath: string): string {
	return normalize(resolve(expandHome(filepath)));
}

/**
 * Check whether a pattern contains unsupported mid-path wildcards.
 * Only trailing wildcards are supported. Mid-path wildcards silently fail.
 */
function hasMidPathWildcard(pattern: string): boolean {
	// Strip trailing wildcard(s), then check if any wildcards remain
	const withoutTrailing = pattern.replace(/\/?\*{1,2}$/, "");
	return withoutTrailing.includes("*");
}

/**
 * Check whether a single pattern matches a resolved absolute path.
 * Returns true if the path matches the pattern.
 *
 * Pattern types:
 *   - Ends with `/*` or `/**` → directory prefix match
 *   - Ends with `*` (but not `/*`) → prefix match on the literal prefix
 *   - Otherwise → exact match
 *
 * Mid-path wildcards are NOT supported and will not match anything.
 * Use hasMidPathWildcard() to detect and warn about these before calling.
 */
function matchesPattern(resolvedPath: string, pattern: string): boolean {
	const expandedPattern = resolvePath(pattern.replace(/\/?\*{1,2}$/, ""));

	// Directory match: pattern ends with /* or /**
	if (pattern.endsWith("/**") || pattern.endsWith("/*")) {
		const dirPrefix = expandedPattern.endsWith("/") ? expandedPattern : `${expandedPattern}/`;
		// Match the directory itself or anything under it
		return resolvedPath === expandedPattern || resolvedPath.startsWith(dirPrefix);
	}

	// Prefix match: pattern ends with * (e.g. ~/.ssh/id_*)
	if (pattern.endsWith("*")) {
		return resolvedPath.startsWith(expandedPattern);
	}

	// Exact match
	return resolvedPath === resolvePath(pattern);
}

/**
 * Check whether a file path points to a sensitive credential file.
 *
 * Resolves the input to an absolute, normalized path (expanding `~`),
 * then checks against built-in and optional extra patterns.
 *
 * SSH public keys (`*.pub`) are explicitly allowlisted even though
 * they match the `~/.ssh/id_*` pattern.
 */
export function isSensitivePath(filepath: string, extraPatterns?: string[]): SensitivePathResult {
	const resolved = resolvePath(filepath);

	// Check default patterns
	for (const pattern of DEFAULT_SENSITIVE_PATTERNS) {
		if (matchesPattern(resolved, pattern)) {
			// Special case: SSH id_* pattern — allowlist .pub files
			if (pattern === "~/.ssh/id_*" && resolved.endsWith(SSH_PUB_SUFFIX)) {
				continue;
			}
			return { blocked: true, pattern };
		}
	}

	// Check extra patterns
	if (extraPatterns) {
		for (const pattern of extraPatterns) {
			if (hasMidPathWildcard(pattern)) {
				// Mid-path wildcards like ~/vaults/*/key.pem are not supported.
				// Skip with a console warning so misconfigurations are visible.
				console.warn(
					`[sensitive-paths] Skipping unsupported mid-path wildcard pattern: "${pattern}". Only trailing wildcards (e.g. "~/.ssh/id_*", "~/.secrets/*") are supported.`,
				);
				continue;
			}
			if (matchesPattern(resolved, pattern)) {
				return { blocked: true, pattern };
			}
		}
	}

	return { blocked: false };
}
