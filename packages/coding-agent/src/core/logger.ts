/**
 * Structured logger that routes messages appropriately based on mode.
 *
 * In interactive TUI mode (when stderr is taken over):
 * - debug: suppressed unless DREB_DEBUG=1
 * - warn/error: routed through the stderr callback → displayed in TUI feed
 *
 * In non-interactive modes (JSON, RPC, print, or before TUI starts):
 * - All levels write to real stderr (the diagnostic side-channel)
 */

import { isStderrTakenOver, writeRawStderr } from "./stderr-guard.js";

export type LogLevel = "debug" | "warn" | "error";

const isDebugEnabled = (): boolean => process.env.DREB_DEBUG === "1";

/**
 * Write a message to stderr. In interactive mode, this goes through the
 * stderr guard's callback (which routes to TUI display). In non-interactive
 * mode, it writes directly to stderr.
 */
function writeToStderr(message: string): void {
	if (isStderrTakenOver()) {
		// Write through the intercepted path — the callback will handle routing
		process.stderr.write(message);
	} else {
		// Direct write to real stderr
		writeRawStderr(`${message}\n`);
	}
}

export const log = {
	/**
	 * Debug-level message. Suppressed in interactive mode unless DREB_DEBUG=1.
	 * Always writes to stderr in non-interactive modes.
	 */
	debug(message: string): void {
		if (isStderrTakenOver()) {
			if (isDebugEnabled()) {
				process.stderr.write(message);
			}
			// Otherwise silently suppressed
		} else {
			writeRawStderr(`${message}\n`);
		}
	},

	/**
	 * Warning-level message. Always displayed to the user.
	 * In TUI: shown in chat feed. In non-interactive: written to stderr.
	 */
	warn(message: string): void {
		writeToStderr(message);
	},

	/**
	 * Error-level message. Always displayed to the user.
	 * In TUI: shown in chat feed. In non-interactive: written to stderr.
	 */
	error(message: string): void {
		writeToStderr(message);
	},
};
