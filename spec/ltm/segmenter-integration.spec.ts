/* oxlint-disable no-non-null-assertion, require-await, no-await-in-loop -- test assertions */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EpisodicMemory } from "../../packages/ltm/src/episodic.ts";
import { LtmStorage } from "../../packages/ltm/src/ltm-storage.ts";
import type { SegmentationOutput } from "../../packages/ltm/src/segmenter.ts";
import { Segmenter } from "../../packages/ltm/src/segmenter.ts";
import type { ChatMessage } from "../../packages/ltm/src/types.ts";
import { SURPRISE_VALUES } from "../../packages/ltm/src/types.ts";
import { createMockLLM, makeMessage } from "./test-helpers.ts";

const userId = "user-1";

function createSegmentationLLM(segmentationResponse?: SegmentationOutput) {
	return createMockLLM({ structuredResponse: segmentationResponse ?? { segments: [] } });
}

async function addMessagesSequentially(
	segmenter: Segmenter,
	count: number,
	roleFn: (i: number) => ChatMessage["role"] = () => "user",
): Promise<void> {
	for (let i = 0; i < count; i++) {
		await segmenter.addMessage(userId, makeMessage(`message ${i}`, roleFn(i)));
	}
}

describe("Integration: Segmenter + LtmStorage + EpisodicMemory", () => {
	let storage: LtmStorage;

	beforeEach(() => {
		storage = new LtmStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("full flow: addMessage → segmentation → episode saved → retrievable via EpisodicMemory", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Integration Test Topic",
					summary: "Testing the full pipeline with SQLite storage",
					surprise: "high",
				},
			],
		};

		const llm = createSegmentationLLM(segResponse);
		const segmenter = new Segmenter(llm, storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});
		const episodic = new EpisodicMemory(storage);

		await addMessagesSequentially(segmenter, 5, (i) => (i % 2 === 0 ? "user" : "assistant"));

		const episodes = await episodic.getEpisodes(userId);
		expect(episodes).toHaveLength(1);

		const ep = episodes[0]!;
		expect(ep.title).toBe("Integration Test Topic");
		expect(ep.summary).toBe("Testing the full pipeline with SQLite storage");
		expect(ep.surprise).toBe(SURPRISE_VALUES.high);
		expect(ep.messages).toHaveLength(5);
		expect(ep.embedding).toEqual([0.1, 0.2, 0.3]);
	});

	test("episode is searchable after segmentation", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "TypeScript Best Practices",
					summary: "Discussion about TypeScript coding standards",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});
		const episodic = new EpisodicMemory(storage);

		await addMessagesSequentially(segmenter, 5);

		const results = await episodic.search(userId, "typescript", 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("TypeScript Best Practices");
	});

	test("FSRS review works on stored episode", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "FSRS Test",
					summary: "Testing FSRS review on SQLite",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});
		const episodic = new EpisodicMemory(storage);

		await addMessagesSequentially(segmenter, 5);

		const episodes = await episodic.getEpisodes(userId);
		const ep = episodes[0]!;

		const now = new Date();
		const card = await episodic.review(userId, ep.id, { rating: "good", now });
		expect(card).not.toBeNull();
		expect(card!.lastReviewedAt).toEqual(now);

		const updated = await episodic.getEpisodeById(userId, ep.id);
		expect(updated!.lastReviewedAt!.getTime()).toBe(now.getTime());
	});

	test("multiple segments create multiple episodes", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "First Discussion",
					summary: "First topic discussed",
					surprise: "low",
				},
				{
					startIndex: 5,
					endIndex: 10,
					title: "Second Discussion",
					summary: "Second topic discussed",
					surprise: "extremely_high",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 10,
			hardTrigger: 20,
		});
		const episodic = new EpisodicMemory(storage);

		await addMessagesSequentially(segmenter, 10);

		const episodes = await episodic.getEpisodes(userId);
		expect(episodes).toHaveLength(2);

		const surprises = episodes.map((e) => e.surprise).toSorted();
		expect(surprises).toContain(SURPRISE_VALUES.low);
		expect(surprises).toContain(SURPRISE_VALUES.extremely_high);
	});

	test("remaining messages stay in queue after partial segmentation", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 6,
					title: "Partial Segment",
					summary: "Only first 6 messages",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 10,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, 10);

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(4);
		expect(queue[0]!.content).toBe("message 6");
	});

	test("consolidation marking persists", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Consolidation Test",
					summary: "Testing consolidation mark",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});
		const episodic = new EpisodicMemory(storage);

		await addMessagesSequentially(segmenter, 5);

		const episodes = await episodic.getEpisodes(userId);
		await episodic.markConsolidated(userId, episodes[0]!.id);

		const unconsolidated = await episodic.getUnconsolidated(userId);
		expect(unconsolidated).toHaveLength(0);

		const consolidated = await episodic.getEpisodeById(userId, episodes[0]!.id);
		expect(consolidated!.consolidatedAt).not.toBeNull();
	});
});
