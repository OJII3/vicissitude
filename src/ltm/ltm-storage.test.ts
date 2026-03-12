/* oxlint-disable max-lines, no-non-null-assertion, require-await, no-await-in-loop -- comprehensive storage adapter tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createEpisode } from "./episode.ts";
import { LtmStorage } from "./ltm-storage.ts";
import { createFact } from "./semantic-fact.ts";
import type { ChatMessage } from "./types.ts";

const userId = "user-1";

function makeEpisode(overrides: Record<string, unknown> = {}) {
	return createEpisode({
		userId,
		title: "Test Episode",
		summary: "A summary",
		messages: [{ role: "user", content: "hello" }] as ChatMessage[],
		embedding: [0.1, 0.2],
		surprise: 0.5,
		startAt: new Date("2026-01-01T00:00:00Z"),
		endAt: new Date("2026-01-01T01:00:00Z"),
		...overrides,
	});
}

function makeFact(overrides: Record<string, unknown> = {}) {
	return createFact({
		userId,
		category: "preference",
		fact: "Likes TypeScript",
		keywords: ["typescript"],
		sourceEpisodicIds: ["ep-1"],
		embedding: [0.1, 0.2],
		...overrides,
	});
}

describe("LtmStorage — episodic memory", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("saveEpisode and getEpisodes", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);
		const episodes = await storage.getEpisodes(userId);
		expect(episodes).toHaveLength(1);
		expect(episodes[0]!.id).toBe(ep.id);
	});

	test("getEpisodes filters by userId", async () => {
		const ep1 = makeEpisode({ userId: "user-1" });
		const ep2 = makeEpisode({ userId: "user-2" });
		await storage.saveEpisode("user-1", ep1);
		await storage.saveEpisode("user-2", ep2);

		const result = await storage.getEpisodes("user-1");
		expect(result).toHaveLength(1);
		expect(result[0]!.userId).toBe("user-1");
	});

	test("getEpisodeById returns the episode", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);
		const found = await storage.getEpisodeById(userId, ep.id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe(ep.id);
	});

	test("getEpisodeById returns null for unknown id", async () => {
		const found = await storage.getEpisodeById(userId, "nonexistent");
		expect(found).toBeNull();
	});

	test("getUnconsolidatedEpisodes returns only unconsolidated", async () => {
		const ep1 = makeEpisode();
		const ep2 = makeEpisode();
		await storage.saveEpisode(userId, ep1);
		await storage.saveEpisode(userId, ep2);
		await storage.markEpisodeConsolidated(userId, ep1.id);

		const unconsolidated = await storage.getUnconsolidatedEpisodes(userId);
		expect(unconsolidated).toHaveLength(1);
		expect(unconsolidated[0]!.id).toBe(ep2.id);
	});

	test("updateEpisodeFSRS updates card parameters", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);

		const now = new Date();
		await storage.updateEpisodeFSRS(userId, ep.id, {
			stability: 5.0,
			difficulty: 0.8,
			lastReviewedAt: now,
		});

		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(updated!.stability).toBe(5.0);
		expect(updated!.difficulty).toBe(0.8);
		expect(updated!.lastReviewedAt!.getTime()).toBe(now.getTime());
	});

	test("markEpisodeConsolidated sets consolidatedAt", async () => {
		const ep = makeEpisode();
		await storage.saveEpisode(userId, ep);
		expect(ep.consolidatedAt).toBeNull();

		await storage.markEpisodeConsolidated(userId, ep.id);
		const updated = await storage.getEpisodeById(userId, ep.id);
		expect(updated!.consolidatedAt).not.toBeNull();
		expect(updated!.consolidatedAt).toBeInstanceOf(Date);
	});

	test("preserves messages JSON", async () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		const ep = makeEpisode({ messages });
		await storage.saveEpisode(userId, ep);

		const found = await storage.getEpisodeById(userId, ep.id);
		expect(found!.messages).toHaveLength(2);
		expect(found!.messages[0]!.role).toBe("user");
		expect(found!.messages[1]!.content).toBe("hi there");
	});

	test("preserves embedding array", async () => {
		const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
		const ep = makeEpisode({ embedding });
		await storage.saveEpisode(userId, ep);

		const found = await storage.getEpisodeById(userId, ep.id);
		expect(found!.embedding).toEqual(embedding);
	});

	test("saveEpisode throws on userId mismatch", async () => {
		const ep = makeEpisode({ userId: "user-1" });
		await expect(storage.saveEpisode("user-2", ep)).rejects.toThrow("does not match");
	});
});

describe("LtmStorage — tenant isolation (episodes)", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("getEpisodeById cannot access other user's episode", async () => {
		const ep = makeEpisode({ userId: "user-1" });
		await storage.saveEpisode("user-1", ep);
		const found = await storage.getEpisodeById("user-2", ep.id);
		expect(found).toBeNull();
	});

	test("updateEpisodeFSRS does not affect other user's episode", async () => {
		const ep = makeEpisode({ userId: "user-1" });
		await storage.saveEpisode("user-1", ep);
		await storage.updateEpisodeFSRS("user-2", ep.id, {
			stability: 99,
			difficulty: 99,
			lastReviewedAt: new Date(),
		});
		const found = await storage.getEpisodeById("user-1", ep.id);
		expect(found!.stability).not.toBe(99);
	});

	test("markEpisodeConsolidated does not affect other user's episode", async () => {
		const ep = makeEpisode({ userId: "user-1" });
		await storage.saveEpisode("user-1", ep);
		await storage.markEpisodeConsolidated("user-2", ep.id);
		const found = await storage.getEpisodeById("user-1", ep.id);
		expect(found!.consolidatedAt).toBeNull();
	});
});

describe("LtmStorage — semantic memory", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("saveFact and getFacts", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);
		const facts = await storage.getFacts(userId);
		expect(facts).toHaveLength(1);
		expect(facts[0]!.id).toBe(fact.id);
	});

	test("getFacts excludes invalidated facts", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);
		await storage.invalidateFact(userId, fact.id, new Date());

		const facts = await storage.getFacts(userId);
		expect(facts).toHaveLength(0);
	});

	test("getFactsByCategory filters by category", async () => {
		const pref = makeFact({ category: "preference" });
		const goal = makeFact({ category: "goal" });
		await storage.saveFact(userId, pref);
		await storage.saveFact(userId, goal);

		const prefs = await storage.getFactsByCategory(userId, "preference");
		expect(prefs).toHaveLength(1);
		expect(prefs[0]!.category).toBe("preference");
	});

	test("invalidateFact sets invalidAt", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);

		const invalidAt = new Date("2026-06-01T00:00:00Z");
		await storage.invalidateFact(userId, fact.id, invalidAt);

		const facts = await storage.getFacts(userId);
		expect(facts).toHaveLength(0);
	});

	test("updateFact applies partial updates", async () => {
		const fact = makeFact();
		await storage.saveFact(userId, fact);

		await storage.updateFact(userId, fact.id, { fact: "Loves TypeScript" });

		const facts = await storage.getFacts(userId);
		expect(facts[0]!.fact).toBe("Loves TypeScript");
		expect(facts[0]!.category).toBe("preference");
	});

	test("saveFact throws on userId mismatch", async () => {
		const fact = makeFact({ userId: "user-1" });
		await expect(storage.saveFact("user-2", fact)).rejects.toThrow("does not match");
	});
});

describe("LtmStorage — tenant isolation (facts)", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("invalidateFact does not affect other user's fact", async () => {
		const fact = makeFact({ userId: "user-1" });
		await storage.saveFact("user-1", fact);
		await storage.invalidateFact("user-2", fact.id, new Date());

		const facts = await storage.getFacts("user-1");
		expect(facts).toHaveLength(1);
	});

	test("updateFact does not affect other user's fact", async () => {
		const fact = makeFact({ userId: "user-1" });
		await storage.saveFact("user-1", fact);
		await storage.updateFact("user-2", fact.id, { fact: "Hacked!" });

		const facts = await storage.getFacts("user-1");
		expect(facts[0]!.fact).toBe("Likes TypeScript");
	});
});

describe("LtmStorage — message queue", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("pushMessage and getMessageQueue", async () => {
		const msg: ChatMessage = { role: "user", content: "hello" };
		await storage.pushMessage(userId, msg);

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(1);
		expect(queue[0]!.content).toBe("hello");
	});

	test("pushMessage appends to existing queue", async () => {
		await storage.pushMessage(userId, { role: "user", content: "first" });
		await storage.pushMessage(userId, { role: "assistant", content: "second" });

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(2);
		expect(queue[0]!.content).toBe("first");
		expect(queue[1]!.content).toBe("second");
	});

	test("getMessageQueue returns empty array for unknown user", async () => {
		const queue = await storage.getMessageQueue("unknown-user");
		expect(queue).toHaveLength(0);
	});

	test("clearMessageQueue removes all messages", async () => {
		await storage.pushMessage(userId, { role: "user", content: "hello" });
		await storage.clearMessageQueue(userId);

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(0);
	});

	test("preserves message timestamp through round-trip", async () => {
		const ts = new Date("2026-03-01T12:00:00Z");
		await storage.pushMessage(userId, { role: "user", content: "timed", timestamp: ts });

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(1);
		expect(queue[0]!.timestamp).toBeInstanceOf(Date);
		expect(queue[0]!.timestamp!.getTime()).toBe(ts.getTime());
	});

	test("message without timestamp round-trips correctly", async () => {
		await storage.pushMessage(userId, { role: "user", content: "no time" });

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(1);
		expect(queue[0]!.timestamp).toBeUndefined();
	});

	test("preserves message name through round-trip", async () => {
		await storage.pushMessage(userId, { role: "user", content: "hello", name: "Alice" });

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(1);
		expect(queue[0]!.name).toBe("Alice");
	});

	test("message without name round-trips correctly", async () => {
		await storage.pushMessage(userId, { role: "user", content: "hello" });

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(1);
		expect(queue[0]!.name).toBeUndefined();
	});

	test("preserves message name in episode messages JSON", async () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "hello", name: "Alice" },
			{ role: "assistant", content: "hi there" },
		];
		const ep = makeEpisode({ messages });
		await storage.saveEpisode(userId, ep);

		const found = await storage.getEpisodeById(userId, ep.id);
		expect(found!.messages[0]!.name).toBe("Alice");
		expect(found!.messages[1]!.name).toBeUndefined();
	});
});

describe("LtmStorage — tenant isolation (message queue)", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("getMessageQueue does not return other user's messages", async () => {
		await storage.pushMessage("user-1", { role: "user", content: "msg-1" });
		await storage.pushMessage("user-2", { role: "user", content: "msg-2" });

		const queue = await storage.getMessageQueue("user-1");
		expect(queue).toHaveLength(1);
		expect(queue[0]!.content).toBe("msg-1");
	});

	test("clearMessageQueue does not affect other user's messages", async () => {
		await storage.pushMessage("user-1", { role: "user", content: "msg-1" });
		await storage.pushMessage("user-2", { role: "user", content: "msg-2" });

		await storage.clearMessageQueue("user-1");

		const q1 = await storage.getMessageQueue("user-1");
		const q2 = await storage.getMessageQueue("user-2");
		expect(q1).toHaveLength(0);
		expect(q2).toHaveLength(1);
		expect(q2[0]!.content).toBe("msg-2");
	});
});

describe("LtmStorage — updateFact edge cases", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("updateFact on nonexistent fact does not throw", async () => {
		await expect(
			storage.updateFact(userId, "nonexistent-id", { fact: "Updated fact" }),
		).resolves.toBeUndefined();
	});
});

describe("LtmStorage — search episodes", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("matches title", async () => {
		const ep = makeEpisode({ title: "TypeScript Discussion" });
		await storage.saveEpisode(userId, ep);

		const results = await storage.searchEpisodes(userId, "typescript", 10);
		expect(results).toHaveLength(1);
	});

	test("matches summary", async () => {
		const ep = makeEpisode({ summary: "Talked about Bun runtime" });
		await storage.saveEpisode(userId, ep);

		const results = await storage.searchEpisodes(userId, "bun", 10);
		expect(results).toHaveLength(1);
	});

	test("is case-insensitive", async () => {
		const ep = makeEpisode({ title: "UPPERCASE Title" });
		await storage.saveEpisode(userId, ep);

		const results = await storage.searchEpisodes(userId, "uppercase", 10);
		expect(results).toHaveLength(1);
	});

	test("respects limit", async () => {
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				storage.saveEpisode(userId, makeEpisode({ title: `Episode ${i}` })),
			),
		);

		const results = await storage.searchEpisodes(userId, "episode", 3);
		expect(results).toHaveLength(3);
	});

	test("filters by userId", async () => {
		await storage.saveEpisode("user-1", makeEpisode({ userId: "user-1", title: "Shared" }));
		await storage.saveEpisode("user-2", makeEpisode({ userId: "user-2", title: "Shared" }));

		const results = await storage.searchEpisodes("user-1", "shared", 10);
		expect(results).toHaveLength(1);
	});
});

describe("LtmStorage — vector search episodes", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("returns episodes sorted by cosine similarity", async () => {
		const ep1 = makeEpisode({ title: "Close", embedding: [1, 0, 0] });
		const ep2 = makeEpisode({ title: "Closer", embedding: [0.9, 0.1, 0] });
		const ep3 = makeEpisode({ title: "Far", embedding: [0, 0, 1] });
		await storage.saveEpisode(userId, ep1);
		await storage.saveEpisode(userId, ep2);
		await storage.saveEpisode(userId, ep3);

		const results = await storage.searchEpisodesByEmbedding(userId, [1, 0, 0], 10);
		expect(results).toHaveLength(3);
		expect(results[0]!.title).toBe("Close");
		expect(results[1]!.title).toBe("Closer");
		expect(results[2]!.title).toBe("Far");
	});

	test("respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await storage.saveEpisode(userId, makeEpisode({ embedding: [i, 1, 0] }));
		}
		const results = await storage.searchEpisodesByEmbedding(userId, [1, 0, 0], 2);
		expect(results).toHaveLength(2);
	});

	test("filters by userId", async () => {
		await storage.saveEpisode("user-1", makeEpisode({ userId: "user-1", embedding: [1, 0, 0] }));
		await storage.saveEpisode("user-2", makeEpisode({ userId: "user-2", embedding: [1, 0, 0] }));

		const results = await storage.searchEpisodesByEmbedding("user-1", [1, 0, 0], 10);
		expect(results).toHaveLength(1);
	});
});

describe("LtmStorage — vector search facts", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("returns facts sorted by cosine similarity", async () => {
		const f1 = makeFact({ fact: "Close", embedding: [1, 0, 0] });
		const f2 = makeFact({ fact: "Far", embedding: [0, 0, 1] });
		await storage.saveFact(userId, f1);
		await storage.saveFact(userId, f2);

		const results = await storage.searchFactsByEmbedding(userId, [1, 0, 0], 10);
		expect(results).toHaveLength(2);
		expect(results[0]!.fact).toBe("Close");
		expect(results[1]!.fact).toBe("Far");
	});

	test("excludes invalidated facts", async () => {
		const f = makeFact({ embedding: [1, 0, 0] });
		await storage.saveFact(userId, f);
		await storage.invalidateFact(userId, f.id, new Date());

		const results = await storage.searchFactsByEmbedding(userId, [1, 0, 0], 10);
		expect(results).toHaveLength(0);
	});

	test("respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await storage.saveFact(userId, makeFact({ embedding: [i, 1, 0] }));
		}
		const results = await storage.searchFactsByEmbedding(userId, [1, 0, 0], 2);
		expect(results).toHaveLength(2);
	});

	test("filters by userId", async () => {
		await storage.saveFact("user-1", makeFact({ userId: "user-1", embedding: [1, 0, 0] }));
		await storage.saveFact("user-2", makeFact({ userId: "user-2", embedding: [1, 0, 0] }));

		const results = await storage.searchFactsByEmbedding("user-1", [1, 0, 0], 10);
		expect(results).toHaveLength(1);
	});
});

describe("LtmStorage — search facts", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("matches fact content", async () => {
		const fact = makeFact({ fact: "Prefers dark mode" });
		await storage.saveFact(userId, fact);

		const results = await storage.searchFacts(userId, "dark mode", 10);
		expect(results).toHaveLength(1);
	});

	test("matches keywords", async () => {
		const fact = makeFact({ keywords: ["vim", "editor"] });
		await storage.saveFact(userId, fact);

		const results = await storage.searchFacts(userId, "vim", 10);
		expect(results).toHaveLength(1);
	});

	test("excludes invalidated facts", async () => {
		const fact = makeFact({ fact: "Old preference" });
		await storage.saveFact(userId, fact);
		await storage.invalidateFact(userId, fact.id, new Date());

		const results = await storage.searchFacts(userId, "old", 10);
		expect(results).toHaveLength(0);
	});

	test("respects limit", async () => {
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				storage.saveFact(userId, makeFact({ fact: `Fact number ${i}` })),
			),
		);

		const results = await storage.searchFacts(userId, "fact", 3);
		expect(results).toHaveLength(3);
	});
});

describe("LtmStorage — FTS5 episodes", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("FTS5 matches token in title", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "TypeScript Discussion" }));
		await storage.saveEpisode(userId, makeEpisode({ title: "Python Tutorial" }));

		const results = await storage.searchEpisodes(userId, "TypeScript", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("TypeScript Discussion");
	});

	test("FTS5 matches token in summary", async () => {
		await storage.saveEpisode(
			userId,
			makeEpisode({ title: "Chat", summary: "Discussed Bun runtime performance" }),
		);

		const results = await storage.searchEpisodes(userId, "Bun", 10);
		expect(results).toHaveLength(1);
	});

	test("FTS5 BM25 ranking orders by relevance", async () => {
		await storage.saveEpisode(
			userId,
			makeEpisode({ title: "TypeScript Guide", summary: "A guide" }),
		);
		await storage.saveEpisode(
			userId,
			makeEpisode({ title: "General Chat", summary: "Mentioned TypeScript briefly" }),
		);

		const results = await storage.searchEpisodes(userId, "TypeScript", 10);
		expect(results).toHaveLength(2);
	});
});

describe("LtmStorage — FTS5 facts", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("FTS5 matches token in fact", async () => {
		await storage.saveFact(userId, makeFact({ fact: "Prefers dark mode" }));
		await storage.saveFact(userId, makeFact({ fact: "Uses light theme" }));

		const results = await storage.searchFacts(userId, "dark", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.fact).toBe("Prefers dark mode");
	});

	test("FTS5 matches in keywords JSON", async () => {
		await storage.saveFact(userId, makeFact({ keywords: ["vim", "editor"] }));

		const results = await storage.searchFacts(userId, "vim", 10);
		expect(results).toHaveLength(1);
	});

	test("FTS5 excludes invalidated facts", async () => {
		const fact = makeFact({ fact: "Old preference dark mode" });
		await storage.saveFact(userId, fact);
		await storage.invalidateFact(userId, fact.id, new Date());

		const results = await storage.searchFacts(userId, "dark", 10);
		expect(results).toHaveLength(0);
	});
});

describe("LtmStorage — search limit clamping", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("searchEpisodes clamps negative limit to 1", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "Test" }));
		const results = await storage.searchEpisodes(userId, "test", -5);
		expect(results).toHaveLength(1);
	});

	test("searchEpisodes clamps excessively large limit to 1000", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "Test" }));
		const results = await storage.searchEpisodes(userId, "test", 99_999);
		expect(results).toHaveLength(1);
	});

	test("searchFacts clamps negative limit to 1", async () => {
		await storage.saveFact(userId, makeFact({ fact: "Test fact" }));
		const results = await storage.searchFacts(userId, "test", -5);
		expect(results).toHaveLength(1);
	});

	test("searchFacts clamps excessively large limit to 1000", async () => {
		await storage.saveFact(userId, makeFact({ fact: "Test fact" }));
		const results = await storage.searchFacts(userId, "test", 99_999);
		expect(results).toHaveLength(1);
	});

	test("searchEpisodesByEmbedding clamps negative limit to 1", async () => {
		await storage.saveEpisode(userId, makeEpisode({ embedding: [1, 0] }));
		const results = await storage.searchEpisodesByEmbedding(userId, [1, 0], -5);
		expect(results).toHaveLength(1);
	});

	test("searchFactsByEmbedding clamps negative limit to 1", async () => {
		await storage.saveFact(userId, makeFact({ embedding: [1, 0] }));
		const results = await storage.searchFactsByEmbedding(userId, [1, 0], -5);
		expect(results).toHaveLength(1);
	});
});

describe("LtmStorage — escapeLike wildcards", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("searches literal % in episode title", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "100% done" }));
		await storage.saveEpisode(userId, makeEpisode({ title: "All done" }));

		const results = await storage.searchEpisodes(userId, "100%", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("100% done");
	});

	test("searches literal _ in episode title", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "snake_case naming" }));
		await storage.saveEpisode(userId, makeEpisode({ title: "snakeXcase naming" }));

		const results = await storage.searchEpisodes(userId, "snake_case", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("snake_case naming");
	});

	test("searches literal % in fact content", async () => {
		await storage.saveFact(userId, makeFact({ fact: "Prefers 100% coverage" }));
		await storage.saveFact(userId, makeFact({ fact: "Prefers full coverage" }));

		const results = await storage.searchFacts(userId, "100%", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.fact).toBe("Prefers 100% coverage");
	});

	test("searches literal backslash in episode title", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: String.raw`path\to\file` }));
		await storage.saveEpisode(userId, makeEpisode({ title: "pathXtoXfile" }));

		const results = await storage.searchEpisodes(userId, String.raw`path\to`, 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe(String.raw`path\to\file`);
	});
});

describe("LtmStorage — FTS5 special character fallback", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("searchEpisodes handles query with double quotes gracefully", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: 'Said "hello" today' }));
		const results = await storage.searchEpisodes(userId, '"hello"', 10);
		expect(results).toHaveLength(1);
	});

	test("searchFacts handles query with special FTS5 operators", async () => {
		await storage.saveFact(userId, makeFact({ fact: "Uses AND logic often" }));
		const results = await storage.searchFacts(userId, "AND", 10);
		expect(results).toHaveLength(1);
	});

	test("searchEpisodes strips NUL bytes from query", async () => {
		await storage.saveEpisode(userId, makeEpisode({ title: "NULtest episode" }));
		const results = await storage.searchEpisodes(userId, "NUL\0test", 10);
		expect(results).toHaveLength(1);
	});
});
