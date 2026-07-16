import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { expandPath } from "./tools/path-utils.js";

/** Global-only policy controlling lazy nested context loading. */
export interface ContextTrustPolicy {
	/** Expert opt-in allowing any strictly resolvable tool target. */
	unrestricted: boolean;
	/** Configured folder roots. Invalid or unavailable roots are ignored fail-closed. */
	trustedFolders: string[];
}

export interface ContextTrustMatch {
	/** Canonical directory the tool will operate in. */
	targetDir: string;
	/** Canonical trusted root that grants access, absent for unrestricted access. */
	trustedRoot?: string;
}

/** Strict native realpath. Unlike normal path handling, failures never fall back to input. */
export function strictNativeRealpath(path: string): string | null {
	try {
		return realpathSync.native(path);
	} catch {
		return null;
	}
}

/** True only for a path equal to or below a canonical directory on a segment boundary. */
export function isWithinCanonicalRoot(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Resolve an existing directory through native realpath, or fail without lexical fallback. */
export function canonicalizeDirectory(path: string): string | null {
	const canonical = strictNativeRealpath(path);
	if (!canonical) return null;
	try {
		return statSync(canonical).isDirectory() ? canonical : null;
	} catch {
		return null;
	}
}

function normalizeCanonicalRoots(canonicalRoots: readonly string[]): string[] {
	const effectiveRoots: string[] = [];
	for (const canonicalRoot of canonicalRoots) {
		if (effectiveRoots.some((root) => isWithinCanonicalRoot(root, canonicalRoot))) continue;

		// A later parent root subsumes previously configured descendants.
		for (let i = effectiveRoots.length - 1; i >= 0; i--) {
			if (isWithinCanonicalRoot(canonicalRoot, effectiveRoots[i])) effectiveRoots.splice(i, 1);
		}
		effectiveRoots.push(canonicalRoot);
	}
	return effectiveRoots;
}

/**
 * Canonicalize configured trusted roots into the enforceable set. Only absolute paths (after
 * settings-style `~` expansion) are eligible: relative and empty values must never inherit the
 * process cwd. Missing paths, broken symlinks, and non-directories are ignored fail-closed.
 * Canonically duplicate roots are deduped and roots below another effective root are subsumed.
 */
export function canonicalizeTrustedRoots(configuredRoots: readonly string[]): string[] {
	const canonicalRoots: string[] = [];

	for (const configuredRoot of configuredRoots) {
		const expandedRoot = expandPath(configuredRoot);
		if (!isAbsolute(expandedRoot)) continue;

		const canonicalRoot = canonicalizeDirectory(expandedRoot);
		if (canonicalRoot) canonicalRoots.push(canonicalRoot);
	}

	return normalizeCanonicalRoots(canonicalRoots);
}

/**
 * Validate one settings/RPC trusted-folder path. Only absolute paths after settings-style
 * `~` expansion are accepted; the result is a strict-native-realpath existing directory.
 */
export function validateTrustedContextFolder(path: unknown): string {
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new Error("expected a non-empty path string");
	}
	const expandedPath = expandPath(path);
	if (!isAbsolute(expandedPath)) {
		throw new Error("path must be absolute after ~ expansion");
	}
	const canonicalPath = canonicalizeDirectory(expandedPath);
	if (!canonicalPath) {
		throw new Error("path must be an existing directory");
	}
	return canonicalPath;
}

/**
 * Validate a settings/RPC trusted-folder update before it is applied. Unlike the
 * fail-closed reader above, this rejects every invalid entry so updates are atomic.
 * Returned roots are strict-native-realpath canonical, deduplicated, and subsumed.
 */
export function validateTrustedContextFolders(configuredRoots: unknown): string[] {
	if (!Array.isArray(configuredRoots)) {
		throw new Error("trustedContextFolders must be an array of non-empty path strings");
	}

	const canonicalRoots: string[] = [];
	for (const [index, configuredRoot] of configuredRoots.entries()) {
		try {
			canonicalRoots.push(validateTrustedContextFolder(configuredRoot));
		} catch (error) {
			throw new Error(`Invalid trustedContextFolders[${index}]: ${(error as Error).message}`);
		}
	}

	return normalizeCanonicalRoots(canonicalRoots);
}

/**
 * Resolve a lazy-load target against the global policy. Every configured root and the target
 * must resolve natively at decision time; missing paths, broken symlinks, and non-directories
 * are deliberately denied rather than treated as lexical paths.
 */
export function matchContextTrust(policy: ContextTrustPolicy, targetDir: string): ContextTrustMatch | null {
	const canonicalTarget = canonicalizeDirectory(targetDir);
	if (!canonicalTarget) return null;
	if (policy.unrestricted) return { targetDir: canonicalTarget };

	for (const canonicalRoot of canonicalizeTrustedRoots(policy.trustedFolders)) {
		if (isWithinCanonicalRoot(canonicalRoot, canonicalTarget)) {
			return { targetDir: canonicalTarget, trustedRoot: canonicalRoot };
		}
	}
	return null;
}
