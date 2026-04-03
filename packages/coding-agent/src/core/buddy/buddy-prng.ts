/**
 * Mulberry32 PRNG and FNV-1a hash for deterministic buddy generation.
 * Bones are derived from hash(username + hostname + salt + rerollCount) on every session start.
 */

/** FNV-1a 32-bit hash of a string */
export function fnv1a(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Mulberry32 PRNG — fast, deterministic 32-bit */
export function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Create a PRNG seeded from user identity + salt + reroll count.
 * This ensures the same user gets the same buddy unless they reroll.
 */
export function createBuddySeed(username: string, hostname: string, salt: string, rerollCount: number): number {
	const input = `${username}@${hostname}:${salt}:${rerollCount}`;
	return fnv1a(input);
}

/**
 * Create a PRNG from user identity. Returns a function that produces
 * floats in [0, 1).
 */
export function createBuddyRng(username: string, hostname: string, salt: string, rerollCount: number): () => number {
	return mulberry32(createBuddySeed(username, hostname, salt, rerollCount));
}

/** Roll an integer in [min, max] inclusive using the given RNG */
export function rollInt(rng: () => number, min: number, max: number): number {
	return Math.floor(rng() * (max - min + 1)) + min;
}

/** Roll a float in [min, max) using the given RNG */
export function rollFloat(rng: () => number, min: number, max: number): number {
	return rng() * (max - min) + min;
}

/**
 * Pick a weighted item from a map of item -> weight.
 * Returns the key whose cumulative weight contains the roll.
 */
export function rollWeighted<T extends string>(rng: () => number, weights: Record<T, number>): T {
	const entries = Object.entries(weights) as [T, number][];
	const total = entries.reduce((a, b) => a + b[1], 0);
	let roll = rng() * total;
	for (const [key, weight] of entries) {
		roll -= weight;
		if (roll <= 0) return key;
	}
	// Fallback to last key (floating point edge case)
	const keys = Object.keys(weights) as T[];
	return keys[keys.length - 1];
}
