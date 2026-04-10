/**
 * BuddyComponent — TUI component rendering the buddy companion.
 *
 * Renders below the editor with:
 * - 3-frame idle animation cycling at 500ms
 * - Speech bubbles for reactions and name-call responses
 * - Pet hearts animation (2.5s)
 * - Narrow terminal fallback (<100 cols)
 * - Stat display and rarity badge
 */

import type { Component, MarkdownTheme as MT, TUI } from "@dreb/tui";
import { joinColumns, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@dreb/tui";
import { marked } from "marked";
import { applyEyes, getSpeciesFrames, getSpeciesWidth } from "../../../core/buddy/buddy-species.js";
import type { BuddyState } from "../../../core/buddy/buddy-types.js";
import { Rarity, Stat } from "../../../core/buddy/buddy-types.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const IDLE_INTERVAL_MS = 500;
const SPEECH_BUBBLE_DURATION_MS = 10000;
const PET_DURATION_MS = 2500;
const HEART_CHARS = ["❤️", "💕", "💖", "💗", "✨"];
const NARROW_THRESHOLD = 100;
const SPEECH_MAX_CONTENT_LINES = 3;
const SIDE_PANEL_GAP = 2;

export class BuddyComponent implements Component {
	private ui: TUI;
	private state: BuddyState;
	private interval: ReturnType<typeof setInterval> | null = null;

	// Animation state
	private currentFrame = 0;
	private totalFrames = 3;

	// Speech bubble
	private speechText: string | null = null;
	private speechTimeout: ReturnType<typeof setTimeout> | null = null;

	// Pet animation
	private isPetting = false;
	private petTimeout: ReturnType<typeof setTimeout> | null = null;
	private hearts: Array<{ x: number; y: number; char: string; life: number }> = [];

	// Thinking indicator
	private thinkingLabel: string | null = null;
	private thinkingDots = 0;
	private static readonly THINKING_DOT_COUNT = 4; // cycles 0,1,2,3 → ".", "..", "...", "...."

	// Cached render
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cachedVersion = -1;
	private renderVersion = 0;

	constructor(ui: TUI, state: BuddyState) {
		this.ui = ui;
		this.state = state;
		this.totalFrames = getSpeciesFrames(state.species).length;
		this.startAnimation();
	}

	/** Update buddy state (e.g. after reroll) */
	updateState(state: BuddyState): void {
		this.state = state;
		this.totalFrames = getSpeciesFrames(state.species).length;
		this.currentFrame = 0;
		this.bumpVersion();
		this.ui.requestRender();
	}

	/** Show a speech bubble with text */
	showSpeech(text: string): void {
		this.speechText = text;
		if (this.speechTimeout) clearTimeout(this.speechTimeout);
		this.speechTimeout = setTimeout(() => {
			this.speechText = null;
			this.speechTimeout = null;
			this.bumpVersion();
			this.ui.requestRender();
		}, SPEECH_BUBBLE_DURATION_MS);
		this.bumpVersion();
		this.ui.requestRender();
	}

	/** Trigger pet animation */
	pet(): void {
		this.isPetting = true;
		// Spawn hearts
		const spriteWidth = getSpeciesWidth(this.state.species);
		for (let i = 0; i < 5; i++) {
			this.hearts.push({
				x: Math.floor(Math.random() * spriteWidth),
				y: -1 - Math.floor(Math.random() * 3),
				char: HEART_CHARS[Math.floor(Math.random() * HEART_CHARS.length)],
				life: 5 + Math.floor(Math.random() * 5),
			});
		}
		if (this.petTimeout) clearTimeout(this.petTimeout);
		this.petTimeout = setTimeout(() => {
			this.isPetting = false;
			this.hearts = [];
			this.petTimeout = null;
			this.bumpVersion();
			this.ui.requestRender();
		}, PET_DURATION_MS);
		this.bumpVersion();
		this.ui.requestRender();
	}

	/** Show a pulsing thinking indicator with optional label */
	showThinking(label?: string): void {
		this.thinkingLabel = label ?? "thinking";
		this.thinkingDots = 0;
		this.bumpVersion();
		this.ui.requestRender();
	}

	/** Hide the thinking indicator */
	hideThinking(): void {
		this.thinkingLabel = null;
		this.thinkingDots = 0;
		this.bumpVersion();
		this.ui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.renderVersion) {
			return this.cachedLines;
		}

		if (width < NARROW_THRESHOLD) {
			this.cachedLines = this.renderNarrow(width);
		} else {
			this.cachedLines = this.renderFull(width);
		}

		this.cachedWidth = width;
		this.cachedVersion = this.renderVersion;
		return this.cachedLines;
	}

	dispose(): void {
		this.stopAnimation();
		this.thinkingLabel = null;
		if (this.speechTimeout) {
			clearTimeout(this.speechTimeout);
			this.speechTimeout = null;
		}
		if (this.petTimeout) {
			clearTimeout(this.petTimeout);
			this.petTimeout = null;
		}
	}

	// =============================================================================
	// Full rendering (wide terminal)
	// =============================================================================

	private renderFull(width: number): string[] {
		const lines: string[] = [];
		const frames = getSpeciesFrames(this.state.species);
		const frame = frames[this.currentFrame % this.totalFrames];
		const rendered = applyEyes(frame, this.state.eyeStyle);
		const spriteWidth = getSpeciesWidth(this.state.species);

		// Build LEFT block: hat + heart animation + sprite lines
		const leftLines: string[] = [];

		// Hat line
		if (this.state.hat) {
			const hatPad = Math.max(0, Math.floor((spriteWidth - 1) / 2) - 1);
			leftLines.push(" ".repeat(hatPad) + this.state.hat);
		}

		// Heart animation line (above sprite, inserted at top)
		if (this.isPetting && this.hearts.length > 0) {
			const heartLine = " ".repeat(spriteWidth);
			const chars = heartLine.split("");
			for (const heart of this.hearts) {
				const x = Math.min(heart.x, chars.length - 2);
				if (x >= 0 && heart.life > 0) {
					const hChar = heart.char;
					chars.splice(x, hChar.length, ...hChar.split(""));
				}
			}
			leftLines.push(chars.join(""));
		}

		// Sprite lines
		leftLines.push(...rendered);

		// Build RIGHT block: speech bubble or thinking indicator
		let rightLines: string[] = [];
		if (this.speechText) {
			const availableWidth = width - spriteWidth - SIDE_PANEL_GAP - 5; // 5 for leading space + bubble borders + padding
			const bubbleMaxWidth = Math.max(20, availableWidth);
			rightLines = this.formatSpeechBubble(this.speechText, bubbleMaxWidth);
		} else if (this.thinkingLabel !== null) {
			const dots = ".".repeat((this.thinkingDots % BuddyComponent.THINKING_DOT_COUNT) + 1);
			const label = this.thinkingLabel || "thinking";
			rightLines = [` ${theme.fg("muted", `💭 ${label}${dots}`)}`];
		}

		// Merge left and right side-by-side
		if (rightLines.length > 0) {
			const merged = joinColumns(leftLines, rightLines, SIDE_PANEL_GAP, width);
			lines.push(...merged);
		} else {
			lines.push(...leftLines);
		}

		// Name + rarity line (full width, below the sprite+panel area)
		const shinyMark = this.state.shiny ? " ✨" : "";
		const rarityColor = this.rarityColor(this.state.rarity);
		const nameLine = ` ${theme.bold(this.state.name)}${shinyMark} ${theme.fg(rarityColor, `[${this.state.rarity}]`)} ${theme.fg("muted", this.state.species)}`;
		lines.push(nameLine);

		// Stats line (full width)
		const statParts = (Object.values(Stat) as Stat[]).map((s) => {
			const val = this.state.stats[s];
			const bar = this.statBar(val);
			return `${theme.fg("muted", s[0])}:${bar}`;
		});
		lines.push(` ${statParts.join(" ")}`);

		return lines;
	}

	// =============================================================================
	// Narrow rendering (< 100 cols)
	// =============================================================================

	private renderNarrow(width: number): string[] {
		const lines: string[] = [];

		// Single-line face
		const eyes = this.state.eyeStyle;
		const mouth = this.isPetting ? "♥" : ">";
		const face = `${this.state.hat}${eyes}${mouth}${eyes}`;

		// Name + truncated quip
		const shinyMark = this.state.shiny ? "✨" : "";
		const name = `${theme.bold(this.state.name)}${shinyMark}`;

		if (this.speechText) {
			const maxQuip = Math.max(10, width - face.length - this.state.name.length - 6);
			const styledQuip = this.renderInlineMarkdown(this.speechText);
			const quip = visibleWidth(styledQuip) > maxQuip ? `${truncateToWidth(styledQuip, maxQuip - 1)}…` : styledQuip;
			lines.push(` ${face} ${name}: ${theme.fg("accent", quip)}`);
		} else if (this.thinkingLabel !== null) {
			const dots = ".".repeat((this.thinkingDots % BuddyComponent.THINKING_DOT_COUNT) + 1);
			const label = this.thinkingLabel || "thinking";
			lines.push(` ${face} ${name} ${theme.fg("muted", `💭 ${label}${dots}`)}`);
		} else {
			lines.push(` ${face} ${name}`);
		}

		return lines;
	}

	// =============================================================================
	// Animation
	// =============================================================================

	private startAnimation(): void {
		this.interval = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.totalFrames;

			// Tick thinking dots
			if (this.thinkingLabel !== null) {
				this.thinkingDots = (this.thinkingDots + 1) % BuddyComponent.THINKING_DOT_COUNT;
			}

			// Tick hearts
			if (this.isPetting) {
				for (const heart of this.hearts) {
					heart.life--;
					heart.y++;
				}
				this.hearts = this.hearts.filter((h) => h.life > 0);
			}

			this.bumpVersion();
			this.ui.requestRender();
		}, IDLE_INTERVAL_MS);
	}

	private stopAnimation(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private bumpVersion(): void {
		this.renderVersion++;
	}

	// =============================================================================
	// Formatting helpers
	// =============================================================================

	private statBar(value: number): string {
		const filled = Math.round(value / 10);
		const empty = 10 - filled;
		const bar = "█".repeat(filled) + "░".repeat(empty);
		const color: "success" | "warning" | "error" = value >= 70 ? "success" : value >= 40 ? "warning" : "error";
		return theme.fg(color, bar);
	}

	private rarityColor(rarity: Rarity): "muted" | "success" | "accent" | "warning" | "error" {
		switch (rarity) {
			case Rarity.COMMON:
				return "muted";
			case Rarity.UNCOMMON:
				return "success";
			case Rarity.RARE:
				return "accent";
			case Rarity.EPIC:
				return "warning";
			case Rarity.LEGENDARY:
				return "error";
		}
	}

	private formatSpeechBubble(text: string, maxWidth: number): string[] {
		if (!text.trim()) return [];

		// Render inline markdown (bold, italic, code) to styled text with ANSI codes
		const styledText = this.renderInlineMarkdown(text);

		// Word-wrap using visible width (ANSI-aware, handles long words)
		const lines = wrapTextWithAnsi(styledText, maxWidth);

		// Enforce hard line cap
		if (lines.length > SPEECH_MAX_CONTENT_LINES) {
			const kept = lines.slice(0, SPEECH_MAX_CONTENT_LINES - 1);
			const lastLine = lines[SPEECH_MAX_CONTENT_LINES - 1];
			// Truncate the last kept line with ellipsis
			const truncated = truncateToWidth(lastLine, maxWidth - 1, "…");
			kept.push(truncated);
			lines.length = 0;
			lines.push(...kept);
		}

		// Wrap in bubble border using visible width for measurement
		const maxLineWidth = Math.max(...lines.map((l) => visibleWidth(l)));
		const bubbleWidth = Math.max(6, Math.min(maxLineWidth + 4, maxWidth + 4));
		const top = `╭${"─".repeat(bubbleWidth - 2)}╮`;
		const bottom = `╰${"─".repeat(bubbleWidth - 2)}╯`;

		const result: string[] = [];
		result.push(` ${theme.fg("accent", top)}`);
		for (const line of lines) {
			const padding = Math.max(0, bubbleWidth - 4 - visibleWidth(line));
			const padded = line + " ".repeat(padding);
			result.push(` ${theme.fg("accent", "│")} ${padded} ${theme.fg("accent", "│")}`);
		}
		result.push(` ${theme.fg("accent", bottom)}`);

		return result;
	}

	/** Render inline markdown tokens (bold, italic, code) to ANSI-styled text */
	private renderInlineMarkdown(text: string): string {
		const mdTheme = getMarkdownTheme();
		const tokens = marked.lexer(text);

		// Flatten: we expect a paragraph containing inline tokens
		const inlineTokens = tokens.flatMap((t: any) =>
			t.type === "paragraph" ? (t.tokens ?? []) : t.type === "text" ? t : [],
		);

		return this.renderInlineTokens(inlineTokens, mdTheme);
	}

	/** Recursively render marked inline tokens to ANSI-styled strings */
	private renderInlineTokens(tokens: any[], mdTheme: MT): string {
		let result = "";
		for (const token of tokens) {
			switch (token.type) {
				case "text":
					result += token.text ?? this.renderInlineTokens(token.tokens ?? [], mdTheme);
					break;
				case "strong":
					result += mdTheme.bold(this.renderInlineTokens(token.tokens ?? [], mdTheme));
					break;
				case "em":
					result += mdTheme.italic(this.renderInlineTokens(token.tokens ?? [], mdTheme));
					break;
				case "codespan":
					result += mdTheme.code(token.text);
					break;
				case "escape":
					result += token.text;
					break;
				default:
					result += token.text ?? token.raw ?? "";
					break;
			}
		}
		return result;
	}
}
