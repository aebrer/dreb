/**
 * Structured logger that routes messages appropriately based on mode.
 *
 * In interactive TUI mode (when stderr is taken over):
 * - debug: suppressed unless DREB_DEBUG=1
 * - warn/error: routed through writeIntercepted with level info → displayed in TUI feed
 *
 * In non-interactive modes (JSON, RPC, print, or before TUI starts):
 * - All levels write to real stderr (the diagnostic side-channel)
 */

import { isStderrTakenOver, writeIntercepted, writeRawStderr } from "./stderr-guard.js";

export type LogLevel = "debug" | "warn" | "error";

const isDebugEnabled = (): boolean => process.env.DREB_DEBUG === "1";

export const log = {
	/**
	 * Debug-level message. Suppressed in interactive mode unless DREB_DEBUG=1.
	 * Always writes to stderr in non-interactive modes.
	 */
	debug(message: string): void {
		if (isStderrTakenOver()) {
			if (isDebugEnabled()) {
				writeIntercepted(message, "debug");
			}
			// Otherwise silently suppressed
		} else {
			writeRawStderr(`${message}\n`);
		}
	},

	/**
	 * Warning-level message. Always displayed to the user.
	 * In TUI: shown in chat feed as warning. In non-interactive: written to stderr.
	 */
	warn(message: string): void {
		if (isStderrTakenOver()) {
			writeIntercepted(message, "warn");
		} else {
			writeRawStderr(`${message}\n`);
		}
	},

	/**
	 * Error-level message. Always displayed to the user.
	 * In TUI: shown in chat feed as error. In non-interactive: written to stderr.
	 */
	error(message: string): void {
		if (isStderrTakenOver()) {
			writeIntercepted(message, "error");
		} else {
			writeRawStderr(`${message}\n`);
		}
	},
};
