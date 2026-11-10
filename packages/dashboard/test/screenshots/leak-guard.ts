/**
 * Leak guard for README screenshots.
 *
 * Before a screenshot is written, the rendered DOM (visible text plus every
 * attribute value, which covers tooltips, hrefs, and aria labels) is scanned for
 * identifying values of the machine running the capture. Any hit fails the
 * capture: published images must only ever contain the fictional scenario.
 */

import { homedir, hostname, userInfo } from "node:os";

export interface LeakNeedle {
	/** Human-readable reason, used in the failure message. */
	label: string;
	value: string;
}

export interface HostIdentity {
	homeDir: string;
	username: string;
	hostname: string;
}

/** Read the capturing machine's identity. Call before the harness overrides HOME. */
export function captureHostIdentity(): HostIdentity {
	return { homeDir: homedir(), username: userInfo().username, hostname: hostname() };
}

/**
 * Values that must never appear in a published screenshot. The username is only
 * matched in home-directory path form, because a bare short username (e.g. a CI
 * account named "runner") can legitimately occur in fictional prose.
 */
export function leakNeedles(host: HostIdentity, sandboxDir: string): LeakNeedle[] {
	const needles: LeakNeedle[] = [
		{ label: "sandbox directory", value: sandboxDir },
		{ label: "real home directory", value: host.homeDir },
	];
	if (host.username) {
		needles.push(
			{ label: "real user home path", value: `/home/${host.username}` },
			{ label: "real user home path", value: `/Users/${host.username}` },
			{ label: "real user home path", value: `\\Users\\${host.username}` },
		);
	}
	// Very short or loopback hostnames are too generic to scan for without false positives.
	if (host.hostname.length >= 4 && host.hostname.toLowerCase() !== "localhost") {
		needles.push({ label: "real hostname", value: host.hostname });
	}
	return needles.filter((needle) => needle.value.length > 1 && needle.value !== "/");
}

export interface LeakFinding {
	label: string;
	value: string;
	context: string;
}

/** Return every needle found in `haystack`, with a short surrounding excerpt. */
export function findLeaks(haystack: string, needles: LeakNeedle[]): LeakFinding[] {
	const findings: LeakFinding[] = [];
	const lowerHaystack = haystack.toLowerCase();
	for (const needle of needles) {
		const index = lowerHaystack.indexOf(needle.value.toLowerCase());
		if (index === -1) continue;
		const start = Math.max(0, index - 40);
		const end = Math.min(haystack.length, index + needle.value.length + 40);
		findings.push({
			label: needle.label,
			value: needle.value,
			context: haystack.slice(start, end).replace(/\s+/g, " "),
		});
	}
	return findings;
}
