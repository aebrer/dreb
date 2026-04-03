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

import type { Component, TUI } from "@dreb/tui";
import { applyEyes, getSpeciesFrames, getSpeciesWidth } from "../../../core/buddy/buddy-species.js";
import type { BuddyState } from "../../../core/buddy/buddy-types.js";
import { Rarity, Stat } from "../../../core/buddy/buddy-types.js";
import { theme } from "../theme/theme.js";

const IDLE_INTERVAL_MS = 500;
const SPEECH_BUBBLE_DURATION_MS = 10000;
const PET_DURATION_MS = 2500;
const HEART_CHARS = ["❤️", "💕", "💖", "💗", "✨"];
const NARROW_THRESHOLD = 100;

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

		// Hat line (if present)
		if (this.state.hat) {
			const hatPad = Math.max(0, Math.floor((getSpeciesWidth(this.state.species) - 1) / 2) - 1);
			lines.push(" ".repeat(hatPad) + this.state.hat);
		}

		// Sprite lines with optional hearts overlay
		const spriteWidth = getSpeciesWidth(this.state.species);
		for (let i = 0; i < rendered.length; i++) {
			const line = rendered[i];

			// Overlay hearts
			if (this.isPetting) {
				for (const heart of this.hearts) {
					if (heart.y === i && heart.x >= 0 && heart.x < line.length) {
						// This is a simple overlay — in practice we'll show hearts above
					}
				}
			}

			lines.push(line);
		}

		// Heart animation line above sprite
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
			// Insert heart line before sprite
			lines.splice(this.state.hat ? 1 : 0, 0, chars.join(""));
		}

		// Name + rarity line
		const shinyMark = this.state.shiny ? " ✨" : "";
		const rarityColor = this.rarityColor(this.state.rarity);
		const nameLine = ` ${theme.bold(this.state.name)}${shinyMark} ${theme.fg(rarityColor, `[${this.state.rarity}]`)} ${theme.fg("muted", this.state.species)}`;
		lines.push(nameLine);

		// Stats line
		const statParts = (Object.values(Stat) as Stat[]).map((s) => {
			const val = this.state.stats[s];
			const bar = this.statBar(val);
			return `${theme.fg("muted", s[0])}:${bar}`;
		});
		lines.push(` ${statParts.join(" ")}`);

		// Speech bubble (beside or below sprite)
		if (this.speechText) {
			const bubbleLines = this.formatSpeechBubble(this.speechText, Math.min(width - 4, 60));
			lines.push(...bubbleLines);
		}

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
			const quip = this.speechText.length > maxQuip ? `${this.speechText.slice(0, maxQuip - 1)}…` : this.speechText;
			lines.push(` ${face} ${name}: ${theme.fg("accent", quip)}`);
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
		const lines: string[] = [];
		const words = text.split(" ");
		let currentLine = "";

		for (const word of words) {
			const test = currentLine ? `${currentLine} ${word}` : word;
			if (test.length > maxWidth) {
				if (currentLine) lines.push(currentLine);
				currentLine = word;
			} else {
				currentLine = test;
			}
		}
		if (currentLine) lines.push(currentLine);

		// Wrap in bubble border
		const bubbleWidth = Math.min(Math.max(...lines.map((l) => l.length)) + 4, maxWidth + 4);
		const top = `╭${"─".repeat(bubbleWidth - 2)}╮`;
		const bottom = `╰${"─".repeat(bubbleWidth - 2)}╯`;

		const result: string[] = [];
		result.push(` ${theme.fg("accent", top)}`);
		for (const line of lines) {
			const padded = line + " ".repeat(bubbleWidth - 4 - line.length);
			result.push(` ${theme.fg("accent", "│")} ${padded} ${theme.fg("accent", "│")}`);
		}
		result.push(` ${theme.fg("accent", bottom)}`);

		return result;
	}
}
