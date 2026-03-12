/* oxlint-disable no-non-null-assertion, require-await, no-await-in-loop -- test assertions */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LtmStorage } from "./ltm-storage.ts";
import { createFact } from "./semantic-fact.ts";
import { SemanticMemory } from "./semantic-memory.ts";

const userId = "user-1";

function makeFact(overrides: Partial<Parameters<typeof createFact>[0]> = {}) {
	return createFact({
		userId,
		category: "preference",
		fact: "User likes TypeScript",
		keywords: ["typescript", "programming"],
		sourceEpisodicIds: ["ep-1"],
		embedding: [0.1, 0.2, 0.3],
		...overrides,
	});
}

describe("SemanticMemory — getFacts", () => {
	let storage: LtmStorage;
	let semantic: SemanticMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		semantic = new SemanticMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("returns empty array when no facts exist", async () => {
		const facts = await semantic.getFacts(userId);
		expect(facts).toHaveLength(0);
	});

	test("returns all valid facts for a user", async () => {
		const fact1 = makeFact({ fact: "Fact 1" });
		const fact2 = makeFact({ fact: "Fact 2" });
		await storage.saveFact(userId, fact1);
		await storage.saveFact(userId, fact2);

		const facts = await semantic.getFacts(userId);
		expect(facts).toHaveLength(2);
	});

	test("does not return facts from other users", async () => {
		const fact1 = makeFact({ userId: "user-1", fact: "User 1 fact" });
		const fact2 = makeFact({ userId: "user-2", fact: "User 2 fact" });
		await storage.saveFact("user-1", fact1);
		await storage.saveFact("user-2", fact2);

		const facts = await semantic.getFacts("user-1");
		expect(facts).toHaveLength(1);
		expect(facts[0]!.fact).toBe("User 1 fact");
	});

	test("does not return invalidated facts", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);
		await storage.invalidateFact(userId, fact.id, new Date());

		const facts = await semantic.getFacts(userId);
		expect(facts).toHaveLength(0);
	});
});

describe("SemanticMemory — getFactsByCategory", () => {
	let storage: LtmStorage;
	let semantic: SemanticMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		semantic = new SemanticMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("returns facts filtered by category", async () => {
		const prefFact = makeFact({ category: "preference", fact: "Likes TS" });
		const idFact = makeFact({ category: "identity", fact: "Is a developer" });
		await storage.saveFact(userId, prefFact);
		await storage.saveFact(userId, idFact);

		const prefs = await semantic.getFactsByCategory(userId, "preference");
		expect(prefs).toHaveLength(1);
		expect(prefs[0]!.fact).toBe("Likes TS");

		const ids = await semantic.getFactsByCategory(userId, "identity");
		expect(ids).toHaveLength(1);
		expect(ids[0]!.fact).toBe("Is a developer");
	});

	test("returns empty array for category with no facts", async () => {
		const fact = makeFact({ category: "preference" });
		await storage.saveFact(userId, fact);

		const goals = await semantic.getFactsByCategory(userId, "goal");
		expect(goals).toHaveLength(0);
	});
});

describe("SemanticMemory — search", () => {
	let storage: LtmStorage;
	let semantic: SemanticMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		semantic = new SemanticMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("finds facts matching query in fact text", async () => {
		const fact1 = makeFact({ fact: "User likes TypeScript", keywords: ["coding"] });
		const fact2 = makeFact({ fact: "User enjoys hiking", keywords: ["outdoor"] });
		await storage.saveFact(userId, fact1);
		await storage.saveFact(userId, fact2);

		const results = await semantic.search(userId, "TypeScript", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.fact).toBe("User likes TypeScript");
	});

	test("finds facts matching query in keywords", async () => {
		const fact = makeFact({ fact: "Enjoys outdoor activities", keywords: ["hiking", "camping"] });
		await storage.saveFact(userId, fact);

		const results = await semantic.search(userId, "hiking", 10);
		expect(results).toHaveLength(1);
	});

	test("respects limit parameter", async () => {
		for (let i = 0; i < 5; i++) {
			const fact = makeFact({ fact: `TypeScript fact ${i}` });
			await storage.saveFact(userId, fact);
		}

		const results = await semantic.search(userId, "TypeScript", 3);
		expect(results).toHaveLength(3);
	});

	test("returns empty array when no match", async () => {
		const fact = makeFact({ fact: "Likes Python" });
		await storage.saveFact(userId, fact);

		const results = await semantic.search(userId, "Rust", 10);
		expect(results).toHaveLength(0);
	});
});

describe("SemanticMemory — invalidate", () => {
	let storage: LtmStorage;
	let semantic: SemanticMemory;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
		semantic = new SemanticMemory(storage);
	});

	afterEach(() => {
		storage.close();
	});

	test("invalidated fact is no longer returned by getFacts", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);

		await semantic.invalidate(userId, fact.id);

		const facts = await semantic.getFacts(userId);
		expect(facts).toHaveLength(0);
	});

	test("invalidated fact uses provided date", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);

		const invalidAt = new Date("2025-01-01");
		await semantic.invalidate(userId, fact.id, invalidAt);

		const allFacts = await storage.getFacts(userId);
		expect(allFacts).toHaveLength(0);
	});
});
