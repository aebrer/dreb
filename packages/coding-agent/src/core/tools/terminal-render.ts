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
 * - CNL (cursor next line): ESC[<n>E
 * - VPA (vertical position absolute): ESC[<row>d
 * - HPA (horizontal position absolute): ESC[<col>G or ESC[<col>`
 *
 * In addition to per-sequence caps, this tracks cumulative cursor position
 * to prevent accumulation attacks where many sequences each at the per-sequence
 * cap combine to push the cursor to millions of rows/columns, triggering OOM
 * via array allocation in the terminal renderer.
 */
export function sanitizeCursorPositioning(input: string): string {
	// Track cumulative cursor position across sequences. An attacker can send
	// thousands of ESC[5000B sequences, each passing the per-sequence cap but
	// accumulating to ~55M rows. By tracking position, we clamp movement that
	// would exceed the limit.
	let cursorRow = 0;
	let cursorCol = 0;

	const parsePart = (p: string | undefined): number | null => {
		if (p === undefined) return null;
		const n = Number.parseInt(p, 10);
		return Number.isNaN(n) ? null : n;
	};

	// Cap all numeric params individually and rebuild the param string
	const capParams = (rawParts: string[]) =>
		rawParts
			.map((p: string) => {
				const n = Number.parseInt(p, 10);
				if (Number.isNaN(n)) return p;
				return String(Math.min(n, MAX_CURSOR_POSITION));
			})
			.join(";");

	// Match CSI sequences: ESC[ followed by params and a final byte
	// Covers H, f (CUP), A/B/C/D (movement), E (CNL), d (VPA), G/` (HPA), r (scroll region)
	return input.replace(/\x1b\[([0-9;]*)([ABCDEGHfdr`])/g, (_match, params: string, cmd: string) => {
		const rawParts = params.split(";");

		switch (cmd) {
			case "B": // Cursor down by n (default 1)
			case "E": {
				// Cursor next line by n (default 1)
				const n = parsePart(rawParts[0]) ?? 1;
				const capped = Math.min(n, MAX_CURSOR_POSITION);
				const allowed = Math.max(0, MAX_CURSOR_POSITION - cursorRow);
				const clamped = Math.min(capped, allowed);
				cursorRow += clamped;
				if (cmd === "E") cursorCol = 0;
				return `\x1b[${clamped}${cmd}`;
			}
			case "A": {
				// Cursor up by n (default 1)
				const n = parsePart(rawParts[0]) ?? 1;
				const capped = Math.min(n, MAX_CURSOR_POSITION);
				cursorRow = Math.max(0, cursorRow - capped);
				return `\x1b[${capped}A`;
			}
			case "C": {
				// Cursor forward by n (default 1)
				const n = parsePart(rawParts[0]) ?? 1;
				const capped = Math.min(n, MAX_CURSOR_POSITION);
				const allowed = Math.max(0, MAX_CURSOR_POSITION - cursorCol);
				const clamped = Math.min(capped, allowed);
				cursorCol += clamped;
				return `\x1b[${clamped}C`;
			}
			case "D": {
				// Cursor back by n (default 1)
				const n = parsePart(rawParts[0]) ?? 1;
				const capped = Math.min(n, MAX_CURSOR_POSITION);
				cursorCol = Math.max(0, cursorCol - capped);
				return `\x1b[${capped}D`;
			}
			case "H":
			case "f": {
				// Absolute cursor position: ESC[row;colH
				const row = parsePart(rawParts[0]);
				const col = parsePart(rawParts[1]);
				cursorRow = row != null ? Math.min(row, MAX_CURSOR_POSITION) : 1;
				cursorCol = col != null ? Math.min(col, MAX_CURSOR_POSITION) : 1;
				return `\x1b[${capParams(rawParts)}${cmd}`;
			}
			case "d": {
				// VPA - vertical position absolute
				const row = parsePart(rawParts[0]);
				cursorRow = row != null ? Math.min(row, MAX_CURSOR_POSITION) : 1;
				return `\x1b[${capParams(rawParts)}d`;
			}
			case "G":
			case "`": {
				// HPA - horizontal position absolute
				const col = parsePart(rawParts[0]);
				cursorCol = col != null ? Math.min(col, MAX_CURSOR_POSITION) : 1;
				return `\x1b[${capParams(rawParts)}${cmd}`;
			}
			case "r": {
				// Set scroll region - cap params, no position tracking
				return `\x1b[${capParams(rawParts)}r`;
			}
			default: {
				return `\x1b[${capParams(rawParts)}${cmd}`;
			}
		}
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
