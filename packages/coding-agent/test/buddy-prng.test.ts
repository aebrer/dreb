/**
 * Unit tests for buddy-prng — PRNG, hashing, and weighted rolling.
 */

import { describe, expect, it } from "vitest";
import {
	createBuddyRng,
	createBuddySeed,
	fnv1a,
	mulberry32,
	rollFloat,
	rollInt,
	rollWeighted,
} from "../src/core/buddy/buddy-prng.js";
import { RARITY_WEIGHTS, Rarity } from "../src/core/buddy/buddy-types.js";

describe("fnv1a", () => {
	it("produces deterministic hashes", () => {
		expect(fnv1a("hello")).toBe(fnv1a("hello"));
		expect(fnv1a("world")).toBe(fnv1a("world"));
	});

	it("produces different hashes for different inputs", () => {
		expect(fnv1a("hello")).not.toBe(fnv1a("world"));
	});

	it("returns a 32-bit unsigned integer", () => {
		const hash = fnv1a("test");
		expect(hash).toBeGreaterThanOrEqual(0);
		expect(hash).toBeLessThanOrEqual(0xffffffff);
		expect(Number.isInteger(hash)).toBe(true);
	});
});

describe("mulberry32", () => {
	it("is deterministic — same seed produces same sequence", () => {
		const rng1 = mulberry32(12345);
		const rng2 = mulberry32(12345);
		for (let i = 0; i < 100; i++) {
			expect(rng1()).toBe(rng2());
		}
	});

	it("produces values in [0, 1)", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 1000; i++) {
			const val = rng();
			expect(val).toBeGreaterThanOrEqual(0);
			expect(val).toBeLessThan(1);
		}
	});

	it("different seeds produce different sequences", () => {
		const rng1 = mulberry32(1);
		const rng2 = mulberry32(2);
		let same = 0;
		for (let i = 0; i < 100; i++) {
			if (rng1() === rng2()) same++;
		}
		// Extremely unlikely all 100 values match
		expect(same).toBeLessThan(100);
	});
});

describe("createBuddySeed", () => {
	it("is deterministic for same inputs", () => {
		expect(createBuddySeed("user", "host", "salt", 0)).toBe(createBuddySeed("user", "host", "salt", 0));
	});

	it("changes with reroll count", () => {
		const s0 = createBuddySeed("user", "host", "salt", 0);
		const s1 = createBuddySeed("user", "host", "salt", 1);
		expect(s0).not.toBe(s1);
	});

	it("changes with username", () => {
		expect(createBuddySeed("alice", "host", "salt", 0)).not.toBe(createBuddySeed("bob", "host", "salt", 0));
	});

	it("changes with hostname", () => {
		expect(createBuddySeed("user", "host1", "salt", 0)).not.toBe(createBuddySeed("user", "host2", "salt", 0));
	});
});

describe("createBuddyRng", () => {
	it("produces a function that returns values in [0, 1)", () => {
		const rng = createBuddyRng("user", "host", "salt", 0);
		for (let i = 0; i < 100; i++) {
			const val = rng();
			expect(val).toBeGreaterThanOrEqual(0);
			expect(val).toBeLessThan(1);
		}
	});
});

describe("rollInt", () => {
	it("produces values within range", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 100; i++) {
			const val = rollInt(rng, 5, 10);
			expect(val).toBeGreaterThanOrEqual(5);
			expect(val).toBeLessThanOrEqual(10);
			expect(Number.isInteger(val)).toBe(true);
		}
	});

	it("can return min and max", () => {
		// With enough rolls, should hit both bounds
		const rng = mulberry32(12345);
		let hitMin = false;
		let hitMax = false;
		for (let i = 0; i < 1000; i++) {
			const val = rollInt(rng, 1, 3);
			if (val === 1) hitMin = true;
			if (val === 3) hitMax = true;
		}
		expect(hitMin).toBe(true);
		expect(hitMax).toBe(true);
	});
});

describe("rollFloat", () => {
	it("produces values within range", () => {
		const rng = mulberry32(42);
		for (let i = 0; i < 100; i++) {
			const val = rollFloat(rng, 0.5, 1.5);
			expect(val).toBeGreaterThanOrEqual(0.5);
			expect(val).toBeLessThan(1.5);
		}
	});
});

describe("rollWeighted", () => {
	it("always returns a valid key", () => {
		const rng = mulberry32(42);
		const weights = { a: 50, b: 30, c: 20 } as const;
		for (let i = 0; i < 100; i++) {
			const result = rollWeighted(rng, weights);
			expect(["a", "b", "c"]).toContain(result);
		}
	});

	it("distributes roughly according to weights over many rolls", () => {
		const rng = mulberry32(42);
		const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
		const N = 10000;
		for (let i = 0; i < N; i++) {
			counts[rollWeighted(rng, { a: 50, b: 30, c: 20 })]++;
		}
		// Should be roughly 50/30/20 — allow 10% tolerance
		expect(counts.a / N).toBeGreaterThan(0.4);
		expect(counts.a / N).toBeLessThan(0.6);
		expect(counts.b / N).toBeGreaterThan(0.2);
		expect(counts.b / N).toBeLessThan(0.4);
		expect(counts.c / N).toBeGreaterThan(0.1);
		expect(counts.c / N).toBeLessThan(0.3);
	});

	it("works with rarity weights", () => {
		const rng = mulberry32(42);
		const result = rollWeighted(rng, RARITY_WEIGHTS);
		expect(Object.values(Rarity)).toContain(result);
	});

	it("handles single-item weights", () => {
		const rng = mulberry32(42);
		const result = rollWeighted(rng, { only: 100 });
		expect(result).toBe("only");
	});
});
