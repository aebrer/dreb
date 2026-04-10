import { TerminalTextRender } from "terminal-render";

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
 */
export function renderTerminalOutput(raw: string): string {
	if (!raw) return raw;
	const renderer = new TerminalTextRender();
	renderer.write(raw);
	return renderer.render();
}
