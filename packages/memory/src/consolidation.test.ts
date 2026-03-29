/* oxlint-disable require-await, no-non-null-assertion -- mock implementations */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ConsolidationOutput } from "./consolidation.ts";
import { ConsolidationPipeline } from "./consolidation.ts";
import type { MemoryLlmPort, Schema } from "./llm-port.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import { MemoryStorage } from "./storage.ts";
import type { ChatMessage } from "./types.ts";

// --- Helpers ---

const userId = "user-1";

function makeEpisode(
	storage: MemoryStorage,
	overrides: { title?: string; consolidated?: boolean } = {},
) {
	const id = crypto.randomUUID();
	const episode = {
		id,
		userId,
		title: overrides.title ?? "Test Episode",
		summary: "A summary",
		messages: [{ role: "user" as const, content: "hello", name: "Alice" }],
		embedding: [0.1, 0.2, 0.3],
		surprise: 0.5,
		stability: 1,
		difficulty: 0.3,
		startAt: new Date("2026-01-01T00:00:00Z"),
		endAt: new Date("2026-01-01T01:00:00Z"),
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastReviewedAt: null,
		consolidatedAt: overrides.consolidated ? new Date() : null,
	};
	// Save directly via storage
	storage.saveEpisode(userId, episode);
	return episode;
}

function makeFact(storage: MemoryStorage, overrides: { id?: string; fact?: string } = {}) {
	const fact: SemanticFact = {
		id: overrides.id ?? crypto.randomUUID(),
		userId,
		category: "preference",
		fact: overrides.fact ?? "Likes TypeScript",
		keywords: ["typescript"],
		sourceEpisodicIds: ["ep-1"],
		embedding: [0.1, 0.2, 0.3],
		validAt: new Date(),
		invalidAt: null,
		createdAt: new Date(),
	};
	storage.saveFact(userId, fact);
	return fact;
}

/** Valid consolidation output for chatStructured mock */
function validOutput(facts: ConsolidationOutput["facts"] = []): ConsolidationOutput {
	return { facts };
}

interface SpyLLM extends MemoryLlmPort {
	chatCalls: ChatMessage[][];
	chatStructuredCalls: ChatMessage[][];
}

function createSpyLLM(
	opts: {
		chatResponse?: string | (() => string);
		chatThrows?: boolean;
		structuredResponse?: ConsolidationOutput;
	} = {},
): SpyLLM {
	const chatCalls: ChatMessage[][] = [];
	const chatStructuredCalls: ChatMessage[][] = [];

	return {
		chatCalls,
		chatStructuredCalls,
		chat: async (messages: ChatMessage[]) => {
			chatCalls.push(messages);
			if (opts.chatThrows) throw new Error("predict failed");
			const resp = opts.chatResponse;
			return typeof resp === "function" ? resp() : (resp ?? "prediction text");
		},
		chatStructured: async <T>(messages: ChatMessage[], schema: Schema<T>) => {
			chatStructuredCalls.push(messages);
			return schema.parse(opts.structuredResponse ?? validOutput());
		},
		embed: async () => [0.1, 0.2, 0.3],
	};
}

// --- Tests ---

describe("ConsolidationPipeline PCL", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage();
	});

	afterEach(() => {
		storage.close();
	});

	describe("processEpisode branching", () => {
		test("no existing facts -> extractFacts (chatStructured only, no chat)", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeEpisode(storage);

			await pipeline.consolidate(userId);

			// extractFacts calls chatStructured, NOT chat (predict)
			expect(llm.chatCalls).toHaveLength(0);
			expect(llm.chatStructuredCalls).toHaveLength(1);
		});

		test("existing facts -> predictCalibrate (chat + chatStructured)", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			// predictCalibrate: chat (predict) then chatStructured (calibrate)
			expect(llm.chatCalls).toHaveLength(1);
			expect(llm.chatStructuredCalls).toHaveLength(1);
		});
	});

	describe("predictCalibrate fallback", () => {
		test("predict failure -> falls back to extractFacts", async () => {
			const llm = createSpyLLM({ chatThrows: true, structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			// Should not throw
			const result = await pipeline.consolidate(userId);

			// predict threw -> extractFacts called via chatStructured
			// predict was attempted
			expect(llm.chatCalls).toHaveLength(1);
			// extractFacts fallback
			expect(llm.chatStructuredCalls).toHaveLength(1);
			expect(result.processedEpisodes).toBe(1);
		});

		test("predict success -> calibrate is called", async () => {
			const llm = createSpyLLM({
				chatResponse: "I predict the user likes TypeScript",
				structuredResponse: validOutput(),
			});
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			// predict succeeded -> calibrate called (not extractFacts)
			expect(llm.chatCalls).toHaveLength(1);
			expect(llm.chatStructuredCalls).toHaveLength(1);

			// Verify calibrate system message contains the prediction
			const calibrateMessages = llm.chatStructuredCalls[0]!;
			const systemMsg = calibrateMessages.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("I predict the user likes TypeScript");
		});
	});

	describe("predict input validation", () => {
		test("user message contains episode summary", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			// default summary is "A summary"
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const predictMessages = llm.chatCalls[0]!;
			const userMsg = predictMessages.find((m) => m.role === "user");
			expect(userMsg?.content).toContain("A summary");
		});

		test("system message contains 'memory prediction agent'", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const predictMessages = llm.chatCalls[0]!;
			const systemMsg = predictMessages.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("memory prediction agent");
		});

		test("user message contains episode title", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage, { title: "My Custom Title" });

			await pipeline.consolidate(userId);

			const predictMessages = llm.chatCalls[0]!;
			const userMsg = predictMessages.find((m) => m.role === "user");
			expect(userMsg?.content).toContain("My Custom Title");
		});

		test("user message contains existing fact text", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage, { fact: "Prefers dark mode" });
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const predictMessages = llm.chatCalls[0]!;
			const userMsg = predictMessages.find((m) => m.role === "user");
			expect(userMsg?.content).toContain("Prefers dark mode");
		});

		test("XML escape is applied to episode title with special characters", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage, { title: "Test <script> & more" });

			await pipeline.consolidate(userId);

			const predictMessages = llm.chatCalls[0]!;
			const userMsg = predictMessages.find((m) => m.role === "user");
			expect(userMsg?.content).toContain("Test &lt;script&gt; &amp; more");
			expect(userMsg?.content).not.toContain("<script>");
		});
	});

	describe("calibrate input validation", () => {
		test("system message contains prediction text", async () => {
			const prediction = "The user will discuss TypeScript preferences";
			const llm = createSpyLLM({
				chatResponse: prediction,
				structuredResponse: validOutput(),
			});
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const calibrateMessages = llm.chatStructuredCalls[0]!;
			const systemMsg = calibrateMessages.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain(prediction);
		});

		test("system message contains existing facts in <existing_facts> tag", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			const fact = makeFact(storage, { fact: "Enjoys hiking" });
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const calibrateMessages = llm.chatStructuredCalls[0]!;
			const systemMsg = calibrateMessages.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("<existing_facts>");
			expect(systemMsg?.content).toContain("Enjoys hiking");
			expect(systemMsg?.content).toContain(fact.id);
		});

		test("user message contains episode content in <episode> tag", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage, { title: "Hiking Chat" });

			await pipeline.consolidate(userId);

			const calibrateMessages = llm.chatStructuredCalls[0]!;
			const userMsg = calibrateMessages.find((m) => m.role === "user");
			expect(userMsg?.content).toContain("<episode>");
			expect(userMsg?.content).toContain("Hiking Chat");
		});
	});

	describe("buildCalibrationPrompt structure", () => {
		test("includes gap types (NOT predicted, CONTRADICT, CONFIRM)", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const systemMsg = llm.chatStructuredCalls[0]!.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("NOT predicted");
			expect(systemMsg?.content).toContain("CONTRADICT");
			expect(systemMsg?.content).toContain("CONFIRM");
		});

		test("includes category definitions", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const systemMsg = llm.chatStructuredCalls[0]!.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("identity");
			expect(systemMsg?.content).toContain("preference");
			expect(systemMsg?.content).toContain("interest");
			expect(systemMsg?.content).toContain("personality");
			expect(systemMsg?.content).toContain("guideline");
		});

		test("includes Predict-Calibrate Learning description", async () => {
			const llm = createSpyLLM({ structuredResponse: validOutput() });
			const pipeline = new ConsolidationPipeline(llm, storage);

			makeFact(storage);
			makeEpisode(storage);

			await pipeline.consolidate(userId);

			const systemMsg = llm.chatStructuredCalls[0]!.find((m) => m.role === "system");
			expect(systemMsg?.content).toContain("Predict-Calibrate Learning");
		});
	});
});

describe("ConsolidationPipeline dedup", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage();
	});

	afterEach(() => {
		storage.close();
	});

	test("dedup fires: identical embedding on action 'new' reinforces existing fact instead", async () => {
		// embed returns same vector as the existing fact -> cosine similarity = 1.0
		const llm = createSpyLLM({
			structuredResponse: validOutput([
				{ action: "new", category: "preference", fact: "Likes TypeScript", keywords: ["ts"] },
			]),
		});
		const pipeline = new ConsolidationPipeline(llm, storage);

		const existingFact = makeFact(storage);
		const episode = makeEpisode(storage);

		const result = await pipeline.consolidate(userId);

		// dedup should have triggered: reinforce instead of new
		expect(result.reinforced).toBe(1);
		expect(result.newFacts).toBe(0);

		// Existing fact's sourceEpisodicIds should include the new episode's id
		const facts = await storage.getFacts(userId);
		const updated = facts.find((f) => f.id === existingFact.id);
		expect(updated).toBeDefined();
		expect(updated!.sourceEpisodicIds).toContain(episode.id);

		// No new fact should have been created
		expect(facts.filter((f) => f.invalidAt === null)).toHaveLength(1);
	});

	test("dedup fires: action 'update' invalidates old fact and reinforces duplicate instead of creating new", async () => {
		// Fact A = update target, Fact B = dedup match
		const factA = makeFact(storage, { fact: "Likes JavaScript" });
		const factB = makeFact(storage, { fact: "Likes TypeScript" });

		const llm = createSpyLLM({
			structuredResponse: validOutput([
				{
					action: "update",
					category: "preference",
					fact: "Likes TypeScript a lot",
					keywords: ["ts"],
					existingFactId: factA.id,
				},
			]),
		});
		// embed returns same vector as existing facts -> cosine similarity = 1.0 -> dedup fires on factB
		const pipeline = new ConsolidationPipeline(llm, storage);

		const episode = makeEpisode(storage);

		const result = await pipeline.consolidate(userId);

		// update counted (applyUpdate returns "update", applyNew's result is not surfaced)
		expect(result.updated).toBe(1);
		expect(result.newFacts).toBe(0);

		// getFacts returns only valid (non-invalidated) facts
		const validFacts = await storage.getFacts(userId);

		// Fact A should be invalidated -> not in valid facts
		expect(validFacts.find((f) => f.id === factA.id)).toBeUndefined();

		// Fact B should have the episode added to sourceEpisodicIds (reinforced via dedup)
		const updatedB = validFacts.find((f) => f.id === factB.id);
		expect(updatedB).toBeDefined();
		expect(updatedB!.sourceEpisodicIds).toContain(episode.id);

		// No new fact was created — only fact B remains valid
		expect(validFacts).toHaveLength(1);
	});

	test("dedup does not fire: different embedding on action 'new' creates new fact", async () => {
		// embed returns a very different vector -> low cosine similarity
		const llm: SpyLLM = {
			...createSpyLLM({
				structuredResponse: validOutput([
					{ action: "new", category: "interest", fact: "Enjoys cooking", keywords: ["cooking"] },
				]),
			}),
			embed: async () => [0.9, -0.1, 0.0],
		};
		const pipeline = new ConsolidationPipeline(llm, storage);

		// existing fact with embedding [0.1, 0.2, 0.3]
		makeFact(storage);
		makeEpisode(storage);

		const result = await pipeline.consolidate(userId);

		// No dedup: should be a new fact
		expect(result.newFacts).toBe(1);
		expect(result.reinforced).toBe(0);

		// Two facts total
		const facts = await storage.getFacts(userId);
		expect(facts.filter((f) => f.invalidAt === null)).toHaveLength(2);
	});
});
