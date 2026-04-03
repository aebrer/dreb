/**
 * Telegram buddy handler — creates and configures a BuddyController
 * with Telegram-specific rendering callbacks and formatting.
 */

import type { BuddyCallbacks, BuddyState } from "@dreb/coding-agent/buddy";
import { BuddyController, BuddyManager, STAT_NAMES, type Stat } from "@dreb/coding-agent/buddy";
import type { Api } from "grammy";
import type { SendFn } from "./events.js";

// ---------------------------------------------------------------------------
// Species emoji mapping
// ---------------------------------------------------------------------------

export const SPECIES_EMOJI: Record<string, string> = {
	Duck: "🦆",
	Goose: "🪿",
	Blob: "🟢",
	Cat: "🐱",
	Dragon: "🐉",
	Octopus: "🐙",
	Owl: "🦉",
	Penguin: "🐧",
	Turtle: "🐢",
	Snail: "🐌",
	Ghost: "👻",
	Axolotl: "🫎",
	Capybara: "🦫",
	Cactus: "🌵",
	Robot: "🤖",
	Rabbit: "🐰",
	Mushroom: "🍄",
	Chonk: "🐹",
};

function speciesEmoji(species: string): string {
	return SPECIES_EMOJI[species] ?? "🐣";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a hatch announcement for Telegram.
 * Species emoji + name/personality/backstory + ASCII art in <pre> code block.
 */
export function formatBuddyHatch(state: BuddyState): string {
	const emoji = speciesEmoji(state.species);
	const shiny = state.shiny ? " ✨Shiny!" : "";
	const lines = [
		`${emoji} *${state.name}* hatched! (${state.rarity}${shiny})`,
		`_${state.personality}_`,
		`_${state.backstory}_`,
		"",
		`<pre>`,
		`  ${state.hat}`,
		`  ${state.eyeStyle}   ${state.eyeStyle}`,
		`</pre>`,
	];
	return lines.join("\n");
}

/**
 * Format a stats panel as a Telegram code block.
 * Shows stat bars using █ and ░ characters.
 */
export function formatBuddyStats(state: BuddyState): string {
	const emoji = speciesEmoji(state.species);
	const shiny = state.shiny ? " ✨" : "";
	const maxBar = 10;

	const lines = [`${emoji} *${state.name}* (${state.species} · ${state.rarity}${shiny})`, "```"];

	for (const stat of STAT_NAMES) {
		const value = state.stats[stat as Stat];
		const filled = Math.round((value / 100) * maxBar);
		const bar = "█".repeat(filled) + "░".repeat(maxBar - filled);
		const label = stat.padEnd(12);
		lines.push(`${label} ${bar} ${value}`);
	}

	lines.push("```");
	return lines.join("\n");
}

/**
 * Format a buddy speech/reaction message.
 */
export function formatBuddySpeech(name: string, text: string): string {
	return `🐣 ${name}: "${text}"`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a BuddyController wired up with Telegram-specific callbacks.
 *
 * @param send — outbox send function (enqueueSend) for reliable delivery
 * @param api — grammy Api instance for chat actions and reactions
 * @param chatId — Telegram chat ID for this user
 */
export function createTelegramBuddyController(send: SendFn, api: Api, chatId: number): BuddyController {
	const manager = new BuddyManager();

	const callbacks: BuddyCallbacks = {
		onSpeech(text: string): void {
			const name = manager.getName() ?? "Buddy";
			send(formatBuddySpeech(name, text));
		},
		onThinkingStart(): void {
			// Fire-and-forget typing indicator
			api.sendChatAction(chatId, "typing").catch(() => {});
		},
		onThinkingEnd(): void {
			// No-op — can't cancel a chat action in Telegram
		},
	};

	const controller = new BuddyController(manager, callbacks, {
		idleTimeoutMs: 30_000,
		reactionCooldownMs: 60_000,
		contextMaxEntries: 20,
		activityGateMs: 7_200_000, // 2 hours
		reactionsPerHour: 3,
	});

	// Auto-load buddy from shared buddy.json (same file TUI uses).
	// If a buddy exists and is visible, it'll be active immediately.
	controller.start();

	return controller;
}
