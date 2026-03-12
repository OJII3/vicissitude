import { describe, expect, test } from "bun:test";

import { cosineSimilarity } from "./vector-math.ts";

describe("cosineSimilarity", () => {
	test("identical vectors return 1.0", () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
	});

	test("orthogonal vectors return 0.0", () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
	});

	test("opposite vectors return -1.0", () => {
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
	});

	test("zero vector returns 0.0", () => {
		expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0.0);
		expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0.0);
		expect(cosineSimilarity([0, 0], [0, 0])).toBe(0.0);
	});

	test("length mismatch throws", () => {
		expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("Vector length mismatch");
	});

	test("scaled vectors return 1.0", () => {
		expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1.0);
	});

	test("single-element vectors", () => {
		expect(cosineSimilarity([5], [3])).toBeCloseTo(1.0);
		expect(cosineSimilarity([5], [-3])).toBeCloseTo(-1.0);
	});

	test("empty vectors return 0.0", () => {
		expect(cosineSimilarity([], [])).toBe(0.0);
	});
});
