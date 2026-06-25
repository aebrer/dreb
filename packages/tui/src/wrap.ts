import { sliceWithWidth, visibleWidth } from "./utils.js";

/**
 * Marker that flags a rendered line as *soft-wrappable*: the renderer is allowed
 * to let the terminal wrap it across multiple rows instead of requiring it to fit
 * within the terminal width. Lines without this marker keep the strict
 * "one line must not exceed width" invariant (and the loud over-width guard).
 *
 * It is a zero-width APC sequence (mirrors CURSOR_MARKER). Terminals ignore
 * unknown APC strings, and `visibleWidth()` already strips APC sequences, so the
 * marker never contributes to measured width. The renderer strips it from the
 * byte stream just before writing, exactly as it does for CURSOR_MARKER.
 */
export const WRAP_MARKER = "\x1b_pi:w\x07";

/** True if `line` carries the soft-wrap marker. */
export function isWrappableLine(line: string): boolean {
	return line.includes(WRAP_MARKER);
}

/** Remove all soft-wrap markers from a line (called at emit time). */
export function stripWrapMarker(line: string): string {
	return line.includes(WRAP_MARKER) ? line.split(WRAP_MARKER).join("") : line;
}

/**
 * Prefix `line` with the soft-wrap marker so the renderer treats it as
 * soft-wrappable. No-op if already marked.
 */
export function markWrappable(line: string): string {
	return line.includes(WRAP_MARKER) ? line : WRAP_MARKER + line;
}

/**
 * Number of terminal rows a single rendered (logical) line occupies at `width`.
 *
 * - Non-wrappable lines always occupy exactly one row (the renderer enforces
 *   that they never exceed `width`). Image lines are also treated as one entry,
 *   matching the renderer's existing accounting.
 * - Wrappable lines occupy `ceil(visibleWidth / width)` rows (minimum one), which
 *   is how the terminal lays them out under autowrap.
 */
export function screenRowsForLine(line: string, width: number, isImage = false): number {
	if (width <= 0) return 1;
	if (isImage || !isWrappableLine(line)) return 1;
	const w = visibleWidth(line);
	if (w <= width) return 1;
	return Math.ceil(w / width);
}

/**
 * Split a (possibly wrappable) line into the terminal rows it would occupy under
 * autowrap, by slicing at fixed `width`-column boundaries. The marker is removed.
 *
 * This is used only for the *transient* in-place viewport repaint (where each
 * screen row must be addressed individually). Content that flows into native
 * scrollback is emitted unwrapped so it copies as a single logical line — this
 * splitter is never used for that path.
 *
 * Non-wrappable lines (and lines that already fit) are returned as a single row.
 */
export function splitToScreenRows(line: string, width: number): string[] {
	const stripped = stripWrapMarker(line);
	if (width <= 0 || !isWrappableLine(line) || visibleWidth(stripped) <= width) {
		return [stripped];
	}
	const rows: string[] = [];
	let col = 0;
	const total = visibleWidth(stripped);
	while (col < total) {
		rows.push(sliceWithWidth(stripped, col, width, true).text);
		col += width;
	}
	return rows.length > 0 ? rows : [stripped];
}
