import { describe, expect, it } from "vitest";
import { cosineSimilarity, packVector, topKSimilar, unpackVector } from "../../src/core/search/vector-store.js";

describe("cosineSimilarity", () => {
	it("returns 1.0 for identical normalized vectors", () => {
		const v = new Float32Array([0.6, 0.8]); // |v| = 1.0
		expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
	});

	it("returns 0.0 for orthogonal vectors", () => {
		const a = new Float32Array([1, 0, 0]);
		const b = new Float32Array([0, 1, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
	});

	it("returns -1.0 for opposite normalized vectors", () => {
		const a = new Float32Array([0.6, 0.8]);
		const b = new Float32Array([-0.6, -0.8]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
	});

	it("computes dot product correctly for arbitrary vectors", () => {
		const a = new Float32Array([1, 2, 3]);
		const b = new Float32Array([4, 5, 6]);
		// dot = 1*4 + 2*5 + 3*6 = 32
		expect(cosineSimilarity(a, b)).toBeCloseTo(32, 5);
	});
});

describe("packVector / unpackVector", () => {
	it("roundtrips Float32Array through Buffer", () => {
		const original = new Float32Array([0.1, -0.5, 3.14, 0, -1e10]);
		const packed = packVector(original);

		expect(packed).toBeInstanceOf(Buffer);
		expect(packed.byteLength).toBe(original.byteLength);

		const unpacked = unpackVector(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
		expect(unpacked.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) {
			expect(unpacked[i]).toBeCloseTo(original[i], 5);
		}
	});

	it("handles empty vector", () => {
		const original = new Float32Array([]);
		const packed = packVector(original);
		const unpacked = unpackVector(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
		expect(unpacked.length).toBe(0);
	});

	it("handles single-element vector", () => {
		const original = new Float32Array([42.0]);
		const packed = packVector(original);
		const unpacked = unpackVector(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
		expect(unpacked[0]).toBeCloseTo(42.0, 5);
	});
});

describe("topKSimilar", () => {
	// Helper: create a map of id → vector
	function makeMap(entries: Array<[number, number[]]>): Map<number, Float32Array> {
		const map = new Map<number, Float32Array>();
		for (const [id, values] of entries) {
			map.set(id, new Float32Array(values));
		}
		return map;
	}

	it("returns correct top-K ordered by descending score", () => {
		const query = new Float32Array([1, 0, 0]);
		const vectors = makeMap([
			[1, [1, 0, 0]], // similarity = 1.0
			[2, [0, 1, 0]], // similarity = 0.0
			[3, [0.5, 0.5, 0]], // similarity = 0.5
			[4, [-1, 0, 0]], // similarity = -1.0
		]);

		const results = topKSimilar(query, vectors, 2);
		expect(results).toHaveLength(2);
		expect(results[0].id).toBe(1);
		expect(results[0].score).toBeCloseTo(1.0, 5);
		expect(results[1].id).toBe(3);
		expect(results[1].score).toBeCloseTo(0.5, 5);
	});

	it("returns empty array when k=0", () => {
		const query = new Float32Array([1, 0]);
		const vectors = makeMap([[1, [1, 0]]]);
		expect(topKSimilar(query, vectors, 0)).toEqual([]);
	});

	it("returns empty array for empty map", () => {
		const query = new Float32Array([1, 0]);
		const vectors = new Map<number, Float32Array>();
		expect(topKSimilar(query, vectors, 5)).toEqual([]);
	});

	it("returns all items when k is larger than map size", () => {
		const query = new Float32Array([1, 0]);
		const vectors = makeMap([
			[1, [1, 0]],
			[2, [0, 1]],
		]);

		const results = topKSimilar(query, vectors, 100);
		expect(results).toHaveLength(2);
		// Still sorted by score descending
		expect(results[0].id).toBe(1);
		expect(results[0].score).toBeCloseTo(1.0, 5);
		expect(results[1].id).toBe(2);
		expect(results[1].score).toBeCloseTo(0.0, 5);
	});

	it("handles negative similarities correctly", () => {
		const query = new Float32Array([1, 0]);
		const vectors = makeMap([
			[1, [-1, 0]], // -1.0
			[2, [-0.5, 0]], // -0.5
			[3, [0.5, 0]], // 0.5
		]);

		const results = topKSimilar(query, vectors, 3);
		expect(results[0].score).toBeCloseTo(0.5, 5);
		expect(results[1].score).toBeCloseTo(-0.5, 5);
		expect(results[2].score).toBeCloseTo(-1.0, 5);
	});
});
