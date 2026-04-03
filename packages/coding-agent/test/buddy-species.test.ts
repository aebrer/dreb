/**
 * Unit tests for buddy-species — species pool, rolling, and rendering.
 */

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/core/buddy/buddy-prng.js";
import {
	ALL_SPECIES,
	applyEyes,
	getSpeciesFrames,
	getSpeciesWidth,
	rollEyes,
	rollHat,
	rollSpecies,
	rollStats,
} from "../src/core/buddy/buddy-species.js";
import { Rarity } from "../src/core/buddy/buddy-types.js";

describe("ALL_SPECIES", () => {
	it("has exactly 18 species", () => {
		expect(ALL_SPECIES).toHaveLength(18);
	});

	it("contains all expected species", () => {
		const expected = [
			"Duck",
			"Goose",
			"Blob",
			"Cat",
			"Dragon",
			"Octopus",
			"Owl",
			"Penguin",
			"Turtle",
			"Snail",
			"Ghost",
			"Axolotl",
			"Capybara",
			"Cactus",
			"Robot",
			"Rabbit",
			"Mushroom",
			"Chonk",
		];
		for (const s of expected) {
			expect(ALL_SPECIES).toContain(s);
		}
	});

	it("has no duplicates", () => {
		expect(new Set(ALL_SPECIES).size).toBe(ALL_SPECIES.length);
	});
});

describe("getSpeciesFrames", () => {
	it("returns 3 frames for each species", () => {
		for (const species of ALL_SPECIES) {
			const frames = getSpeciesFrames(species);
			expect(frames).toHaveLength(3);
		}
	});

	it("each frame is non-empty", () => {
		for (const species of ALL_SPECIES) {
			const frames = getSpeciesFrames(species);
			for (const frame of frames) {
				expect(frame.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("applyEyes", () => {
	it("replaces {E} placeholders", () => {
		const frame = ["  {E}{E}  ", "  {E}{E}  "];
		const result = applyEyes(frame, "●");
		expect(result[0]).toBe("  ●●  ");
		expect(result[1]).toBe("  ●●  ");
	});

	it("works with different eye characters", () => {
		const frame = ["{E}"];
		expect(applyEyes(frame, "○")[0]).toBe("○");
		expect(applyEyes(frame, "◉")[0]).toBe("◉");
	});
});

describe("getSpeciesWidth", () => {
	it("returns positive width for all species", () => {
		for (const species of ALL_SPECIES) {
			expect(getSpeciesWidth(species)).toBeGreaterThan(0);
		}
	});
});

describe("rollSpecies", () => {
	it("returns valid species and rarity", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 100; i++) {
			const { species, rarity } = rollSpecies(rng);
			expect(ALL_SPECIES).toContain(species);
			expect(Object.values(Rarity)).toContain(rarity);
		}
	});

	it("produces different species over many rolls", () => {
		const rng = mulberry32(42);
		const speciesSet = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const { species } = rollSpecies(rng);
			speciesSet.add(species);
		}
		// Should see at least 3 different species over 200 rolls
		expect(speciesSet.size).toBeGreaterThanOrEqual(3);
	});
});

describe("rollEyes", () => {
	it("returns a non-empty string", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 50; i++) {
			const eyes = rollEyes(rng);
			expect(eyes.length).toBeGreaterThan(0);
		}
	});
});

describe("rollHat", () => {
	it("returns a string (possibly empty)", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 50; i++) {
			const hat = rollHat(rng);
			expect(typeof hat).toBe("string");
		}
	});
});

describe("rollStats", () => {
	it("returns all 5 stats", () => {
		const rng = mulberry32(42);
		const stats = rollStats(rng, Rarity.COMMON);
		expect(stats.DEBUGGING).toBeDefined();
		expect(stats.PATIENCE).toBeDefined();
		expect(stats.CHAOS).toBeDefined();
		expect(stats.WISDOM).toBeDefined();
		expect(stats.SNARK).toBeDefined();
	});

	it("all stats are between 0 and 100", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 50; i++) {
			const stats = rollStats(rng, Rarity.COMMON);
			for (const val of Object.values(stats)) {
				expect(val).toBeGreaterThanOrEqual(0);
				expect(val).toBeLessThanOrEqual(100);
			}
		}
	});

	it("legendary stats are generally higher than common", () => {
		// Roll many and compare averages
		const rngCommon = mulberry32(42);
		const rngLegendary = mulberry32(42);

		let commonTotal = 0;
		let legendaryTotal = 0;
		const N = 500;

		for (let i = 0; i < N; i++) {
			const c = rollStats(rngCommon, Rarity.COMMON);
			const l = rollStats(rngLegendary, Rarity.LEGENDARY);
			commonTotal += Object.values(c).reduce((a, b) => a + b, 0);
			legendaryTotal += Object.values(l).reduce((a, b) => a + b, 0);
		}

		expect(legendaryTotal / N).toBeGreaterThan(commonTotal / N);
	});

	it("has one peak stat >= 70", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 50; i++) {
			const stats = rollStats(rng, Rarity.COMMON);
			const vals = Object.values(stats);
			const hasPeak = vals.some((v) => v >= 70);
			expect(hasPeak).toBe(true);
		}
	});
});
