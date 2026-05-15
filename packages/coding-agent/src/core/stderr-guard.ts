/**
 * Stderr interception for interactive TUI mode.
 *
 * When the TUI is active, raw writes to process.stderr would corrupt the
 * differential renderer's state. This module intercepts process.stderr.write
 * and routes all output through a callback instead of letting it hit the terminal.
 *
 * Analogous to output-guard.ts (which handles stdout for non-interactive modes),
 * but specifically for protecting the TUI's display in interactive mode.
 */

type StderrCallback = (message: string) => void;

interface StderrTakeoverState {
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStderrWrite: typeof process.stderr.write;
	callback: StderrCallback;
}

let stderrTakeoverState: StderrTakeoverState | undefined;

/**
 * Intercept all process.stderr.write calls and route them through the callback.
 * Idempotent — multiple calls are no-ops if already taken over.
 */
export function takeOverStderr(callback: StderrCallback): void {
	if (stderrTakeoverState) {
		return;
	}

	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StderrTakeoverState["rawStderrWrite"];
	const originalStderrWrite = process.stderr.write;

	process.stderr.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const text = String(chunk);
		if (text.length > 0) {
			stderrTakeoverState?.callback(text);
		}
		// Signal success to caller — call the callback if provided
		const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (cb) cb(null);
		return true;
	}) as typeof process.stderr.write;

	stderrTakeoverState = {
		rawStderrWrite,
		originalStderrWrite,
		callback,
	};
}

/**
 * Restore the original process.stderr.write behavior.
 */
export function restoreStderr(): void {
	if (!stderrTakeoverState) {
		return;
	}

	process.stderr.write = stderrTakeoverState.originalStderrWrite;
	stderrTakeoverState = undefined;
}

/**
 * Check whether stderr is currently intercepted.
 */
export function isStderrTakenOver(): boolean {
	return stderrTakeoverState !== undefined;
}

/**
 * Write directly to the real stderr, bypassing interception.
 * Use for intentional writes that must reach the terminal
 * (e.g., fatal errors before exit, post-TUI teardown messages).
 */
export function writeRawStderr(text: string): void {
	if (stderrTakeoverState) {
		stderrTakeoverState.rawStderrWrite(text);
		return;
	}
	process.stderr.write(text);
}
