/**
 * Tests for pure formatting functions in the Telegram buddy handler.
 *
 * Covers formatBuddyStats, formatBuddySpeech, and SPECIES_EMOJI.
 */

import type { BuddyState } from "@dreb/coding-agent/buddy";
import { Rarity, Stat } from "@dreb/coding-agent/buddy";
import { describe, expect, it } from "vitest";
import { formatBuddySpeech, formatBuddyStats, SPECIES_EMOJI } from "../src/handlers/buddy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBuddyState(overrides?: Partial<BuddyState>): BuddyState {
	return {
		species: "Duck",
		rarity: Rarity.COMMON,
		shiny: false,
		eyeStyle: "●",
		hat: "",
		stats: {
			[Stat.DEBUGGING]: 50,
			[Stat.PATIENCE]: 70,
			[Stat.CHAOS]: 30,
			[Stat.WISDOM]: 60,
			[Stat.SNARK]: 40,
		},
		personality: "Cheerful and helpful.",
		backstory: "Hatched in a Telegram chat.",
		name: "Testbud",
		rerollCount: 0,
		hatchedAt: "2025-06-15T12:00:00.000Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// formatBuddyStats
// ---------------------------------------------------------------------------

describe("formatBuddyStats", () => {
	it("wraps output in code block markers", () => {
		const result = formatBuddyStats(createMockBuddyState());
		expect(result.startsWith("```\n")).toBe(true);
		expect(result.endsWith("\n```")).toBe(true);
	});

	it("includes the buddy name", () => {
		const result = formatBuddyStats(createMockBuddyState({ name: "Quackers" }));
		expect(result).toContain("Quackers");
	});

	it("includes the species", () => {
		const result = formatBuddyStats(createMockBuddyState({ species: "Cat" }));
		expect(result).toContain("Species:");
		expect(result).toContain("Cat");
	});

	it("includes the rarity", () => {
		const result = formatBuddyStats(createMockBuddyState({ rarity: Rarity.EPIC }));
		expect(result).toContain("Rarity:");
		expect(result).toContain("Epic");
	});

	it("renders stat bars with █ and ░ characters", () => {
		const result = formatBuddyStats(createMockBuddyState());
		expect(result).toContain("█");
		expect(result).toContain("░");
	});

	it("includes the personality", () => {
		const result = formatBuddyStats(createMockBuddyState({ personality: "Sarcastic but lovable." }));
		expect(result).toContain("Sarcastic but lovable.");
	});

	it("includes the backstory", () => {
		const result = formatBuddyStats(createMockBuddyState({ backstory: "Rose from the bitstream." }));
		expect(result).toContain("Rose from the bitstream.");
	});

	it("shows shiny indicator when shiny is true", () => {
		const result = formatBuddyStats(createMockBuddyState({ shiny: true }));
		expect(result).toContain("✨ SHINY!");
	});

	it("hides shiny indicator when shiny is false", () => {
		const result = formatBuddyStats(createMockBuddyState({ shiny: false }));
		expect(result).not.toContain("SHINY!");
	});

	it("displays reroll count", () => {
		const result = formatBuddyStats(createMockBuddyState({ rerollCount: 3 }));
		expect(result).toContain("Re-rolls:");
		expect(result).toContain("3");
	});

	it("displays hatched date", () => {
		const result = formatBuddyStats(createMockBuddyState({ hatchedAt: "2025-12-25T00:00:00.000Z" }));
		expect(result).toContain("Hatched:");
		// The exact date format depends on locale, but it should be present
		expect(result).toMatch(/Hatched:\s+\S+/);
	});

	it("shows 'unknown' when hatchedAt is empty", () => {
		const result = formatBuddyStats(createMockBuddyState({ hatchedAt: "" }));
		expect(result).toContain("Hatched:");
		expect(result).toContain("unknown");
	});

	it("includes eye style and hat", () => {
		const result = formatBuddyStats(createMockBuddyState({ eyeStyle: "◉", hat: "🎩" }));
		expect(result).toContain("◉");
		expect(result).toContain("🎩");
	});

	it("shows 'none' when hat is empty", () => {
		const result = formatBuddyStats(createMockBuddyState({ hat: "" }));
		expect(result).toContain("Hat: none");
	});

	it("flattens newlines in personality and backstory", () => {
		const result = formatBuddyStats(
			createMockBuddyState({
				personality: "Line one\nLine two",
				backstory: "Part A\nPart B\nPart C",
			}),
		);
		// Each should be on a single line (newlines replaced with spaces)
		const personalityLine = result.split("\n").find((l) => l.includes("Personality:"));
		const backstoryLine = result.split("\n").find((l) => l.includes("Backstory:"));
		expect(personalityLine).toBeDefined();
		expect(backstoryLine).toBeDefined();
		expect(personalityLine!.includes("\n")).toBe(false);
		expect(backstoryLine!.includes("\n")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatBuddySpeech
// ---------------------------------------------------------------------------

describe("formatBuddySpeech", () => {
	it("formats speech with species emoji, name, and quoted text", () => {
		const result = formatBuddySpeech("Quackers", "Duck", "Hello world");
		expect(result).toBe('🦆 Quackers: "Hello world"');
	});

	it("uses correct emoji for Cat species", () => {
		const result = formatBuddySpeech("Whiskers", "Cat", "Meow");
		expect(result).toBe('🐱 Whiskers: "Meow"');
	});

	it("uses correct emoji for Dragon species", () => {
		const result = formatBuddySpeech("Smaug", "Dragon", "Rawr");
		expect(result).toBe('🐉 Smaug: "Rawr"');
	});

	it("falls back to 🐣 emoji for unknown species", () => {
		const result = formatBuddySpeech("Mystery", "UnknownSpecies", "...hello?");
		expect(result).toBe('🐣 Mystery: "...hello?"');
	});
});

// ---------------------------------------------------------------------------
// SPECIES_EMOJI
// ---------------------------------------------------------------------------

describe("SPECIES_EMOJI", () => {
	it("has entries for all 18 species", () => {
		const keys = Object.keys(SPECIES_EMOJI);
		expect(keys).toHaveLength(18);
	});

	it("maps Duck to 🦆", () => {
		expect(SPECIES_EMOJI.Duck).toBe("🦆");
	});

	it("maps Cat to 🐱", () => {
		expect(SPECIES_EMOJI.Cat).toBe("🐱");
	});

	it("maps Dragon to 🐉", () => {
		expect(SPECIES_EMOJI.Dragon).toBe("🐉");
	});

	it("maps Ghost to 👻", () => {
		expect(SPECIES_EMOJI.Ghost).toBe("👻");
	});

	it("maps Robot to 🤖", () => {
		expect(SPECIES_EMOJI.Robot).toBe("🤖");
	});

	it("maps Mushroom to 🍄", () => {
		expect(SPECIES_EMOJI.Mushroom).toBe("🍄");
	});

	it("maps Chonk to 🐹", () => {
		expect(SPECIES_EMOJI.Chonk).toBe("🐹");
	});
});
