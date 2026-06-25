import { extractAnsiCode, getSegmenter, sliceWithWidth, visibleWidth } from "./utils.js";

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

type WrapRowSpan = { startCol: number; width: number };

function trailingZeroWidthSuffix(line: string): string {
	const segmenter = getSegmenter();
	let suffixStart = line.length;
	let i = 0;

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment, index } of segmenter.segment(line.slice(i, textEnd))) {
			if (visibleWidth(segment) > 0) {
				suffixStart = i + index + segment.length;
			}
		}
		i = textEnd;
	}

	const suffix = line.slice(suffixStart);
	let result = "";
	let j = 0;
	while (j < suffix.length) {
		const ansi = extractAnsiCode(suffix, j);
		if (ansi) {
			// Do not duplicate APC markers such as CURSOR_MARKER on every split row.
			// The slicer already preserves in-range markers on their actual row.
			if (!ansi.code.startsWith("\x1b_")) result += ansi.code;
			j += ansi.length;
		} else {
			result += suffix[j];
			j++;
		}
	}
	return result;
}

function wrapRowSpans(line: string, width: number): WrapRowSpan[] {
	const rows: WrapRowSpan[] = [];
	const segmenter = getSegmenter();
	let rowStartCol = 0;
	let rowWidth = 0;
	let consumedCol = 0;
	let i = 0;

	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}

		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;

		for (const { segment } of segmenter.segment(line.slice(i, textEnd))) {
			const charWidth = visibleWidth(segment);
			if (charWidth === 0) continue;

			if (rowWidth > 0 && rowWidth + charWidth > width) {
				rows.push({ startCol: rowStartCol, width: rowWidth });
				rowStartCol = consumedCol;
				rowWidth = 0;
			}

			rowWidth += charWidth;
			consumedCol += charWidth;
		}
		i = textEnd;
	}

	if (rowWidth > 0) {
		rows.push({ startCol: rowStartCol, width: rowWidth });
	}

	return rows.length > 0 ? rows : [{ startCol: 0, width: 0 }];
}

/**
 * Number of terminal rows a single rendered (logical) line occupies at `width`.
 *
 * - Non-wrappable lines always occupy exactly one row (the renderer enforces
 *   that they never exceed `width`). Image lines are also treated as one entry,
 *   matching the renderer's existing accounting.
 * - Wrappable lines occupy the rows produced by terminal autowrap. Wide glyphs
 *   never split across rows: if a glyph would straddle the final column, the
 *   terminal starts it on the next row and leaves the trailing column blank.
 */
export function screenRowsForLine(line: string, width: number, isImage = false): number {
	if (width <= 0) return 1;
	if (isImage || !isWrappableLine(line)) return 1;
	const stripped = stripWrapMarker(line);
	if (visibleWidth(stripped) <= width) return 1;
	return wrapRowSpans(stripped, width).length;
}

/**
 * Convert a visible column within a wrappable logical line to terminal row/col
 * coordinates, using the same wide-glyph boundary behavior as `splitToScreenRows`.
 */
export function screenPositionForColumn(line: string, width: number, column: number): { row: number; col: number } {
	if (width <= 0) return { row: 0, col: Math.max(0, column) };
	const stripped = stripWrapMarker(line);
	if (!isWrappableLine(line) || visibleWidth(stripped) <= width) {
		return { row: 0, col: Math.max(0, column) };
	}
	const target = Math.max(0, column);
	const spans = wrapRowSpans(stripped, width);
	for (let row = 0; row < spans.length; row++) {
		const span = spans[row];
		const rowEnd = span.startCol + span.width;
		if (target < rowEnd) {
			return { row, col: target - span.startCol };
		}
		if (target === rowEnd) {
			if (span.width >= width && row + 1 < spans.length) return { row: row + 1, col: 0 };
			return { row, col: span.width };
		}
	}
	const last = spans[spans.length - 1] ?? { startCol: 0, width: 0 };
	return { row: Math.max(0, spans.length - 1), col: Math.max(0, target - last.startCol) };
}

/**
 * Split a (possibly wrappable) line into the terminal rows it would occupy under
 * autowrap, including wide-glyph boundary behavior. The marker is removed.
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
	const suffix = trailingZeroWidthSuffix(stripped);
	const rows = wrapRowSpans(stripped, width).map(
		({ startCol, width: rowWidth }) => sliceWithWidth(stripped, startCol, rowWidth, true).text + suffix,
	);
	return rows.length > 0 ? rows : [stripped];
}
