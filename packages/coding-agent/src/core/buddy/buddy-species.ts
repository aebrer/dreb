/**
 * Species pool, eye styles, hats, and ASCII art frames for the buddy companion.
 *
 * Each species has 3 animation frames using {E} as eye placeholder.
 * Frames cycle at 500ms for idle animation.
 */

import { rollWeighted } from "./buddy-prng.js";
import { EYE_STYLES, HATS, RARITY_WEIGHTS, Rarity, type SpeciesName, STAT_NAMES, type Stat } from "./buddy-types.js";

// =============================================================================
// Species Definitions — 18 species with ASCII art
// =============================================================================

export interface SpeciesDef {
	name: SpeciesName;
	frames: string[][]; // 3 frames, each is string[] (lines)
	rarityFloor: Rarity; // minimum rarity this species can appear at
}

/**
 * All 18 species with 3 animation frames each.
 * {E} is replaced at render time with the buddy's eye style.
 */
const SPECIES_DEFS: Record<SpeciesName, SpeciesDef> = {
	Duck: {
		name: "Duck",
		rarityFloor: Rarity.COMMON,
		frames: [
			["   __     ", "  {E}{E}    ", " <  \\    ", "  \\__\\   ", '  """"   '],
			["   __     ", "  {E}{E}    ", " <  \\    ", "  \\__\\   ", '  """"   '],
			["   __     ", "  {E}{E}    ", " <  \\    ", "  \\__\\   ", "   ~~    "],
		],
	},
	Goose: {
		name: "Goose",
		rarityFloor: Rarity.COMMON,
		frames: [
			["     __   ", "   {E}{E}   ", "  <  \\   ", "   \\__\\  ", '   """"  '],
			["    __    ", "  {E}{E}   ", " <  \\    ", "  \\__\\   ", '  """"   '],
			["   __     ", " {E}{E}    ", "<  \\     ", " \\__\\    ", ' """"    '],
		],
	},
	Blob: {
		name: "Blob",
		rarityFloor: Rarity.COMMON,
		frames: [
			["  .---.  ", " / {E}{E}\\ ", "|  >  | ", " \\ --- / ", "  '---'  "],
			["  .---.  ", " / {E}{E}\\ ", "|  <  | ", " \\ --- / ", "  '---'  "],
			["  .---.  ", " / o o\\ ", "|  ~  | ", " \\ -~- / ", "  '---'  "],
		],
	},
	Cat: {
		name: "Cat",
		rarityFloor: Rarity.COMMON,
		frames: [
			[" /\\_/\\  ", "( {E}.{E} ) ", " >  ^ <  ", "  \\___/  "],
			[" /\\_/\\  ", "( {E}-{E} ) ", " >  = <  ", "  \\___/  "],
			[" /\\_/\\  ", "( {E}.{E} ) ", " >    <  ", "  \\___/  "],
		],
	},
	Dragon: {
		name: "Dragon",
		rarityFloor: Rarity.UNCOMMON,
		frames: [
			["    /\\    ", "   /  \\   ", "  /{E}{E}\\  ", " / --  \\  ", "/ /|  |\\\\ ", "  \\ || /  ", "   \\||/   "],
			["    /\\    ", "   /  \\   ", "  /{E}{E}\\  ", " / ~~  \\  ", "/ /|  |\\ \\ ", "  \\ || /  ", "   \\||/   "],
			["    /\\    ", "   /  \\   ", "  /{E}{E}\\  ", " / --  \\  ", "/ /|  |\\ \\ ", "  \\ || /  ", "    ||    "],
		],
	},
	Octopus: {
		name: "Octopus",
		rarityFloor: Rarity.UNCOMMON,
		frames: [
			["   _  _   ", "  {E}{E}   ", " /| /|\\|  ", "/ | \\ | \\ ", "  |  | |  "],
			["   _  _   ", "  {E}{E}   ", "\\| /|\\|/  ", " | \\ | /| ", "  |  | |  "],
			["   _  _   ", "  {E}{E}   ", " /| /|\\|  ", "  | \\ | \\ ", " \\|  | |  "],
		],
	},
	Owl: {
		name: "Owl",
		rarityFloor: Rarity.UNCOMMON,
		frames: [
			["  ,___,   ", "  {O}{O}   ", "  ([V])   ", ' ,"   ",  ', "  \\___/   "],
			["  ,___,   ", "  {E}{E}   ", "  ([_])   ", ' ,"   ",  ', "  \\___/   "],
			["  ,___,   ", "  {E}{E}   ", "  ([v])   ", ' ,"   ",  ', "  \\___/   "],
		],
	},
	Penguin: {
		name: "Penguin",
		rarityFloor: Rarity.UNCOMMON,
		frames: [
			["   (°)   ", "  /{E}{E}\\  ", " / __  \\ ", " \\    /  ", "  \\__/   "],
			["   (°)   ", "  /{E}{E}\\  ", " / __  \\ ", " \\_  _/  ", "   ||    "],
			["   (°)   ", "  /{E}{E}\\  ", " / __  \\ ", " \\    /  ", "   ||    "],
		],
	},
	Turtle: {
		name: "Turtle",
		rarityFloor: Rarity.COMMON,
		frames: [
			["     ___  ", "    {E}{E}  ", '  .-"""-. ', " /  ___  \\", " \\_______/", "    ||    "],
			["     ___  ", "    {E}{E}  ", '  .-"""-. ', " /  ___  \\", " \\_______/", "    ||    "],
			["     ___  ", "   _{E}{E}_ ", '  .-"""-. ', " /  ___  \\", " \\_______/", "    ||    "],
		],
	},
	Snail: {
		name: "Snail",
		rarityFloor: Rarity.COMMON,
		frames: [
			["    ____  ", "   /    \\ ", "  | {E}{E} | ", "  |  __  |", "   \\    / ", "    ~~    "],
			["    ____  ", "   /    \\ ", "  | {E}{E} | ", "  |  __  |", "   \\    / ", "    ~~    "],
			["    ____  ", "   /    \\ ", "  | {E} {E}| ", "  |  __  |", "   \\    / ", "    ~~    "],
		],
	},
	Ghost: {
		name: "Ghost",
		rarityFloor: Rarity.RARE,
		frames: [
			["   .---.  ", "  / {E}{E}\\ ", " |  >  | ", " |     | ", "  \\~~~~/ ", "   ~~~~   "],
			["   .---.  ", "  / {E}{E}\\ ", " |  ~  | ", " |     | ", "  \\ ~~~/ ", "   ~~~~   "],
			["   .---.  ", "  / o o\\ ", " |  _  | ", " |     | ", "  \\~~~~/ ", "   ~~~~   "],
		],
	},
	Axolotl: {
		name: "Axolotl",
		rarityFloor: Rarity.RARE,
		frames: [
			["   \\||/   ", "  //{E}{E}\\\\  ", "  || > || ", "  \\\\__//  ", '   "||"   '],
			["   \\||/   ", "  //{E}{E}\\\\  ", "  || < || ", "  \\\\__//  ", '   "||"   '],
			["   \\||/   ", "  //{E}{E}\\\\  ", "  || w || ", "  \\\\__//  ", '   "||"   '],
		],
	},
	Capybara: {
		name: "Capybara",
		rarityFloor: Rarity.UNCOMMON,
		frames: [
			["  _    _  ", " {E}{E}  ", "  >    <  ", "  \\____/  ", "   || ||  "],
			["  _    _  ", " {E}{E}  ", "  >    <  ", "  \\____/  ", "   || ||  "],
			["  _    _  ", " {E} {E} ", "  > w  <  ", "  \\____/  ", "   || ||  "],
		],
	},
	Cactus: {
		name: "Cactus",
		rarityFloor: Rarity.COMMON,
		frames: [
			["    _    ", "  _{E}{E}_  ", " |  >  | ", "_|     |_", " |     | ", " |_____| ", "   |||   "],
			["    _    ", "  _{E}{E}_  ", " |  <  | ", "_|     |_", " |     | ", " |_____| ", "   |||   "],
			["    _    ", "  _{E}{E}_  ", " |  ~  | ", "_|     |_", " |     | ", " |_____| ", "   |||   "],
		],
	},
	Robot: {
		name: "Robot",
		rarityFloor: Rarity.EPIC,
		frames: [
			["  [===]  ", "  |{E}{E}|  ", "  | __ | ", "  |____| ", "   |  |  "],
			["  [===]  ", "  |{E}{E}|  ", "  | -- | ", "  |____| ", "   |  |  "],
			["  [===]  ", "  |{E}{E}|  ", "  | ~~ | ", "  |____| ", "   |  |  "],
		],
	},
	Rabbit: {
		name: "Rabbit",
		rarityFloor: Rarity.COMMON,
		frames: [
			["  /\\_/\\  ", " /{E}{E}\\ ", " |  > |  ", "  \\__/   ", "  /  \\   "],
			["  /\\_/\\  ", " /{E}{E}\\ ", " |  < |  ", "  \\__/   ", "  /  \\   "],
			["  /\\_/\\  ", " /{E}{E}\\ ", " | ~  |  ", "  \\__/   ", "   ||    "],
		],
	},
	Mushroom: {
		name: "Mushroom",
		rarityFloor: Rarity.RARE,
		frames: [
			["   .--.  ", "  /{E}{E}\\ ", " |  >  | ", "  \\--/   ", "   ||    ", "  _||_   "],
			["   .--.  ", "  /{E}{E}\\ ", " |  <  | ", "  \\--/   ", "   ||    ", "  _||_   "],
			["   .--.  ", "  /{E}{E}\\ ", " |  ~  | ", "  \\--/   ", "   ||    ", "  _||_   "],
		],
	},
	Chonk: {
		name: "Chonk",
		rarityFloor: Rarity.COMMON,
		frames: [
			["  .----.  ", " / {E}{E}\\  ", "|  >   | ", "|      | ", " \\____/  "],
			["  .----.  ", " / {E}{E}\\  ", "|  <   | ", "|      | ", " \\____/  "],
			["  .----.  ", " / {E}{E}\\  ", "|  w   | ", "|      | ", " \\____/  "],
		],
	},
};

export const ALL_SPECIES = Object.keys(SPECIES_DEFS) as SpeciesName[];

// =============================================================================
// Species selection with rarity weighting
// =============================================================================

/** Species rarity multipliers — rarer species need at least that rarity roll */
const SPECIES_RARITY_FLOORS: Partial<Record<SpeciesName, Rarity>> = {};
for (const def of Object.values(SPECIES_DEFS)) {
	SPECIES_RARITY_FLOORS[def.name] = def.rarityFloor;
}

/**
 * Roll a species from the species pool based on rarity.
 * Species can only appear if the rolled rarity meets their floor.
 */
export function rollSpecies(rng: () => number): { species: SpeciesName; rarity: Rarity } {
	// First roll rarity
	const rarity = rollWeighted(rng, RARITY_WEIGHTS);

	// Filter species available at this rarity tier
	const rarityOrder = [Rarity.COMMON, Rarity.UNCOMMON, Rarity.RARE, Rarity.EPIC, Rarity.LEGENDARY];
	const rarityIndex = rarityOrder.indexOf(rarity);

	const available = ALL_SPECIES.filter((s) => {
		const floor = SPECIES_RARITY_FLOORS[s] ?? Rarity.COMMON;
		const floorIndex = rarityOrder.indexOf(floor);
		return floorIndex <= rarityIndex; // species floor must be <= rolled rarity
	});

	if (available.length === 0) {
		// Shouldn't happen but fallback
		return { species: "Blob", rarity: Rarity.COMMON };
	}

	// Pick random species from available
	const idx = Math.floor(rng() * available.length);
	return { species: available[idx], rarity };
}

// =============================================================================
// Eye and hat selection
// =============================================================================

/** Roll an eye style */
export function rollEyes(rng: () => number): string {
	const idx = Math.floor(rng() * EYE_STYLES.length);
	return EYE_STYLES[idx];
}

/** Roll a hat */
export function rollHat(rng: () => number): string {
	const idx = Math.floor(rng() * HATS.length);
	return HATS[idx];
}

// =============================================================================
// Stat rolling
// =============================================================================

/** Rarity-based stat floor */
function statFloor(rarity: Rarity): number {
	switch (rarity) {
		case Rarity.COMMON:
			return 10;
		case Rarity.UNCOMMON:
			return 20;
		case Rarity.RARE:
			return 35;
		case Rarity.EPIC:
			return 50;
		case Rarity.LEGENDARY:
			return 65;
	}
}

/**
 * Roll RPG-style stats: one peak, one dump, three random.
 * Peak can hit 100, dump near floor.
 */
export function rollStats(rng: () => number, rarity: Rarity): Record<Stat, number> {
	const floor = statFloor(rarity);
	const stats: Partial<Record<Stat, number>> = {};

	// Pick peak and dump stats (must be different)
	const peakStat = STAT_NAMES[Math.floor(rng() * STAT_NAMES.length)];
	let dumpStat = STAT_NAMES[Math.floor(rng() * STAT_NAMES.length)];
	while (dumpStat === peakStat) {
		dumpStat = STAT_NAMES[Math.floor(rng() * STAT_NAMES.length)];
	}

	// Peak: high roll (70-100)
	stats[peakStat] = Math.floor(rng() * 31) + 70;

	// Dump: near floor
	stats[dumpStat] = Math.floor(rng() * 20) + floor;

	// Others: normal range
	for (const stat of STAT_NAMES) {
		if (!(stat in stats)) {
			stats[stat] = Math.floor(rng() * (100 - floor)) + floor;
		}
	}

	return stats as Record<Stat, number>;
}

// =============================================================================
// ASCII art rendering
// =============================================================================

/** Get the 3 animation frames for a species */
export function getSpeciesFrames(species: SpeciesName): string[][] {
	return SPECIES_DEFS[species].frames;
}

/** Replace {E} placeholder with actual eye character */
export function applyEyes(frame: string[], eyes: string): string[] {
	return frame.map((line) => line.replace(/\{E\}/g, eyes));
}

/** Get the maximum width of a species' frames */
export function getSpeciesWidth(species: SpeciesName): number {
	const frames = SPECIES_DEFS[species].frames;
	let maxW = 0;
	for (const frame of frames) {
		for (const line of frame) {
			maxW = Math.max(maxW, line.length);
		}
	}
	return maxW;
}
