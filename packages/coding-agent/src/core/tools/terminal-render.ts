import { TerminalTextRender } from "terminal-render";

/**
 * Maximum row or column value allowed in ANSI cursor positioning sequences.
 * Anything larger gets capped to this value to prevent memory exhaustion from
 * malicious sequences like `ESC[9999999;1H`.
 */
const MAX_CURSOR_POSITION = 5000;

/**
 * Sanitize ANSI cursor positioning sequences to prevent memory exhaustion.
 *
 * Sequences like `ESC[9999999;1H` can cause TerminalTextRender to allocate
 * millions of empty lines. This function caps row/column values in:
 * - CUP (cursor position): ESC[<row>;<col>H  or ESC[<row>;<col>f
 * - CUU/CUD/CUF/CUB (cursor movement): ESC[<n>A/B/C/D
 * - VPA (vertical position absolute): ESC[<row>d
 * - HPA (horizontal position absolute): ESC[<col>G or ESC[<col>`
 */
export function sanitizeCursorPositioning(input: string): string {
	// Match CSI sequences: ESC[ followed by params and a final byte
	// Covers H, f (CUP), A/B/C/D (movement), d (VPA), G/` (HPA)
	return input.replace(/\x1b\[([0-9;]*)([HABCDGHfd`])/g, (_match, params: string, cmd: string) => {
		const capped = params
			.split(";")
			.map((p: string) => {
				const n = Number.parseInt(p, 10);
				if (Number.isNaN(n)) return p;
				return String(Math.min(n, MAX_CURSOR_POSITION));
			})
			.join(";");
		return `\x1b[${capped}${cmd}`;
	});
}

/**
 * Process raw terminal output through a terminal renderer, producing the clean
 * text a human would actually see on screen.
 *
 * This handles:
 * - Carriage returns (`\r`) — progress bars overwrite the current line
 * - ANSI cursor movement — up, down, forward, backward, absolute positioning
 * - Backspace (`\b`) — moves cursor back one position
 * - Line clearing / screen clearing escape sequences
 * - Tab stops
 *
 * The result is the final rendered state of the terminal — identical to what
 * a human would see in a real terminal after the output completes.
 *
 * Safety:
 * - Cursor positioning values are capped to prevent memory exhaustion
 * - Errors fall back to returning the raw input
 */
export function renderTerminalOutput(raw: string): string {
	if (!raw) return raw;
	try {
		const sanitized = sanitizeCursorPositioning(raw);
		const renderer = new TerminalTextRender();
		renderer.write(sanitized);
		return renderer.render();
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`[dreb] terminal-render fallback: TerminalTextRender failed (${detail}), returning raw output`);
		return raw;
	}
}
