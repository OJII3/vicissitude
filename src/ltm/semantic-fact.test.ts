import { describe, expect, test } from "bun:test";

import { createFact } from "./semantic-fact.ts";
import type { FactCategory } from "./types.ts";

const baseParams = () => ({
	userId: "user-1",
	category: "preference" as FactCategory,
	fact: "Likes TypeScript",
	keywords: ["typescript", "language"],
	sourceEpisodicIds: ["ep-1", "ep-2"],
	embedding: [0.1, 0.2, 0.3],
});

describe("createFact", () => {
	test("returns a valid SemanticFact object with all fields", () => {
		const fact = createFact(baseParams());

		expect(fact.userId).toBe("user-1");
		expect(fact.category).toBe("preference");
		expect(fact.fact).toBe("Likes TypeScript");
		expect(fact.keywords).toEqual(["typescript", "language"]);
		expect(fact.sourceEpisodicIds).toEqual(["ep-1", "ep-2"]);
		expect(fact.embedding).toEqual([0.1, 0.2, 0.3]);
	});

	test("id is a valid UUID", () => {
		const fact = createFact(baseParams());
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		expect(fact.id).toMatch(uuidRegex);
	});

	test("each call generates a unique id", () => {
		const f1 = createFact(baseParams());
		const f2 = createFact(baseParams());
		expect(f1.id).not.toBe(f2.id);
	});

	test("validAt is set to approximately now", () => {
		const before = new Date();
		const fact = createFact(baseParams());
		const after = new Date();
		expect(fact.validAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
		expect(fact.validAt.getTime()).toBeLessThanOrEqual(after.getTime());
	});

	test("createdAt equals validAt (same timestamp)", () => {
		const fact = createFact(baseParams());
		expect(fact.createdAt.getTime()).toBe(fact.validAt.getTime());
	});

	test("invalidAt is null", () => {
		const fact = createFact(baseParams());
		expect(fact.invalidAt).toBeNull();
	});
});
