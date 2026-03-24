/* oxlint-disable max-lines, no-non-null-assertion, require-await, no-await-in-loop -- comprehensive segmenter tests */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Episode } from "@vicissitude/memory/episode";
import type { SegmentationOutput } from "@vicissitude/memory/segmenter";
import { Segmenter } from "@vicissitude/memory/segmenter";
import { MemoryStorage } from "@vicissitude/memory/storage";
import type { ChatMessage, SurpriseLevel } from "@vicissitude/memory/types";
import { SURPRISE_VALUES } from "@vicissitude/memory/types";

import { createInvalidLLM, createMockLLM, makeMessage, makeMessages } from "./test-helpers.ts";

function createSegmentationLLM(segmentationResponse?: SegmentationOutput) {
	return createMockLLM({ structuredResponse: segmentationResponse ?? { segments: [] } });
}

async function addMessagesSequentially(
	segmenter: Segmenter,
	targetUserId: string,
	messages: ChatMessage[],
): Promise<void> {
	for (const msg of messages) {
		await segmenter.addMessage(targetUserId, msg);
	}
}

const userId = "user-1";

describe("Segmenter — threshold checks", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("below softTrigger returns no episodes", async () => {
		const segmenter = new Segmenter(createSegmentationLLM(), storage, {
			minMessages: 5,
			softTrigger: 20,
			hardTrigger: 40,
		});

		for (const msg of makeMessages(10)) {
			const episodes = await segmenter.addMessage(userId, msg);
			expect(episodes).toHaveLength(0);
		}

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(10);
	});

	test("softTrigger reached triggers LLM segmentation", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 10,
					title: "First topic",
					summary: "Discussion about first topic",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 10,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(9));

		const episodes = await segmenter.addMessage(userId, makeMessage("trigger"));
		expect(episodes).toHaveLength(1);
		expect(episodes[0]!.title).toBe("First topic");
	});

	test("hardTrigger forces segmentation", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Forced segment",
					summary: "Forced segmentation due to hard trigger",
					surprise: "high",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 10,
			hardTrigger: 5,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(4));

		const episodes = await segmenter.addMessage(userId, makeMessage("trigger"));
		expect(episodes).toHaveLength(1);
		expect(episodes[0]!.title).toBe("Forced segment");
	});

	test("LLM returns no segments at softTrigger returns no episodes", async () => {
		const segmenter = new Segmenter(createSegmentationLLM({ segments: [] }), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(5));

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(5);
	});
});

describe("Segmenter — episode creation", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("created episode has correct fields", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Test Episode",
					summary: "Summary of the test episode",
					surprise: "high",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(5));

		const episodes = await storage.getEpisodes(userId);
		expect(episodes).toHaveLength(1);

		const ep = episodes[0]!;
		expect(ep.title).toBe("Test Episode");
		expect(ep.summary).toBe("Summary of the test episode");
		expect(ep.userId).toBe(userId);
		expect(ep.messages).toHaveLength(5);
		expect(ep.embedding).toEqual([0.1, 0.2, 0.3]);
		expect(ep.surprise).toBe(SURPRISE_VALUES.high);
	});

	test("episode is saved to storage", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Saved Episode",
					summary: "This episode should be saved",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(5));

		const ep = await storage.getEpisodes(userId);
		expect(ep).toHaveLength(1);
		expect(ep[0]!.id).toBeDefined();
	});

	test("multiple segments create multiple episodes", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "First topic",
					summary: "First segment",
					surprise: "low",
				},
				{
					startIndex: 5,
					endIndex: 10,
					title: "Second topic",
					summary: "Second segment",
					surprise: "extremely_high",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 10,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(10));

		const episodes = await storage.getEpisodes(userId);
		expect(episodes).toHaveLength(2);
		expect(episodes.map((e: Episode) => e.title)).toContain("First topic");
		expect(episodes.map((e: Episode) => e.title)).toContain("Second topic");
	});

	test("surprise level maps to correct numeric value", async () => {
		const levels: SurpriseLevel[] = ["low", "high", "extremely_high"];

		for (const level of levels) {
			const localStorage = new MemoryStorage(":memory:");
			const segResponse: SegmentationOutput = {
				segments: [
					{
						startIndex: 0,
						endIndex: 5,
						title: `${level} surprise`,
						summary: `Episode with ${level} surprise`,
						surprise: level,
					},
				],
			};

			const segmenter = new Segmenter(createSegmentationLLM(segResponse), localStorage, {
				minMessages: 3,
				softTrigger: 5,
				hardTrigger: 20,
			});

			await addMessagesSequentially(segmenter, userId, makeMessages(5));

			const episodes = await localStorage.getEpisodes(userId);
			expect(episodes[0]!.surprise).toBe(SURPRISE_VALUES[level]);
			localStorage.close();
		}
	});
});

describe("Segmenter — queue management", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("queue is cleared after segmentation of all messages", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "Complete segment",
					summary: "All messages consumed",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});

		await addMessagesSequentially(segmenter, userId, makeMessages(5));

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(0);
	});

	test("remaining messages are re-queued after partial segmentation", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 6,
					title: "Partial segment",
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

		await addMessagesSequentially(segmenter, userId, makeMessages(10));

		const queue = await storage.getMessageQueue(userId);
		expect(queue).toHaveLength(4);
		expect(queue[0]!.content).toBe("message 6");
	});

	test("messages from different users are isolated", async () => {
		const segResponse: SegmentationOutput = {
			segments: [
				{
					startIndex: 0,
					endIndex: 5,
					title: "User 1 segment",
					summary: "Messages from user 1",
					surprise: "low",
				},
			],
		};

		const segmenter = new Segmenter(createSegmentationLLM(segResponse), storage, {
			minMessages: 3,
			softTrigger: 5,
			hardTrigger: 20,
		});

		for (const msg of makeMessages(3)) {
			await storage.pushMessage("user-2", msg);
		}

		await addMessagesSequentially(segmenter, "user-1", makeMessages(5));

		const user2Queue = await storage.getMessageQueue("user-2");
		expect(user2Queue).toHaveLength(3);

		const user1Episodes = await storage.getEpisodes("user-1");
		expect(user1Episodes).toHaveLength(1);
	});
});

describe("Segmenter — schema validation", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("rejects non-object response", async () => {
		const segmenter = new Segmenter(createInvalidLLM("not an object"), storage, {
			minMessages: 1,
			softTrigger: 2,
			hardTrigger: 5,
		});

		await segmenter.addMessage(userId, makeMessage("first"));
		await expect(segmenter.addMessage(userId, makeMessage("trigger"))).rejects.toThrow(
			"Expected object",
		);
	});

	test("rejects response without segments array", async () => {
		const segmenter = new Segmenter(createInvalidLLM({}), storage, {
			minMessages: 1,
			softTrigger: 2,
			hardTrigger: 5,
		});

		await segmenter.addMessage(userId, makeMessage("first"));
		await expect(segmenter.addMessage(userId, makeMessage("trigger"))).rejects.toThrow(
			"Expected segments array",
		);
	});

	test("rejects segment with missing title", async () => {
		const segmenter = new Segmenter(
			createInvalidLLM({
				segments: [{ startIndex: 0, endIndex: 2, summary: "s", surprise: "low" }],
			}),
			storage,
			{ minMessages: 1, softTrigger: 2, hardTrigger: 5 },
		);

		await segmenter.addMessage(userId, makeMessage("first"));
		await expect(segmenter.addMessage(userId, makeMessage("trigger"))).rejects.toThrow("title");
	});

	test.each([
		["invalid string", "medium"],
		["undefined", undefined],
		["null", null],
		["number", 42],
		["boolean", true],
		["object", {}],
		["array", []],
	])("falls back to low for invalid surprise (%s)", async (_label, surprise) => {
		const segmenter = new Segmenter(
			createInvalidLLM({
				segments: [
					{
						startIndex: 0,
						endIndex: 2,
						title: "t",
						summary: "s",
						surprise,
					},
				],
			}),
			storage,
			{ minMessages: 1, softTrigger: 2, hardTrigger: 5 },
		);

		await segmenter.addMessage(userId, makeMessage("first"));
		const episodes = await segmenter.addMessage(userId, makeMessage("trigger"));
		expect(episodes).toHaveLength(1);
		expect(episodes[0]!.surprise).toBe(0.2);
	});

	test("rejects segment with non-integer startIndex", async () => {
		const segmenter = new Segmenter(
			createInvalidLLM({
				segments: [
					{
						startIndex: 1.5,
						endIndex: 3,
						title: "t",
						summary: "s",
						surprise: "low",
					},
				],
			}),
			storage,
			{ minMessages: 1, softTrigger: 2, hardTrigger: 5 },
		);

		await segmenter.addMessage(userId, makeMessage("first"));
		await expect(segmenter.addMessage(userId, makeMessage("trigger"))).rejects.toThrow(
			"startIndex",
		);
	});
});

describe("Segmenter — maxQueueSize", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("throws when queue exceeds maxQueueSize", async () => {
		const segmenter = new Segmenter(createSegmentationLLM(), storage, {
			minMessages: 5,
			softTrigger: 100,
			hardTrigger: 200,
			maxQueueSize: 3,
		});

		await segmenter.addMessage(userId, makeMessage("msg 1"));
		await segmenter.addMessage(userId, makeMessage("msg 2"));
		await segmenter.addMessage(userId, makeMessage("msg 3"));

		await expect(segmenter.addMessage(userId, makeMessage("msg 4"))).rejects.toThrow(
			"exceeds maximum size",
		);
	});
});

describe("Segmenter — edge cases", () => {
	let storage: MemoryStorage;

	beforeEach(() => {
		storage = new MemoryStorage(":memory:");
	});

	afterEach(() => {
		storage.close();
	});

	test("segment with startIndex === endIndex creates no episode", async () => {
		const invalidLLM = createInvalidLLM({
			segments: [
				{
					startIndex: 2,
					endIndex: 2,
					title: "Empty",
					summary: "No messages",
					surprise: "low",
				},
			],
		});

		const segmenter = new Segmenter(invalidLLM, storage, {
			minMessages: 1,
			softTrigger: 2,
			hardTrigger: 5,
		});

		await segmenter.addMessage(userId, makeMessage("first"));
		await expect(segmenter.addMessage(userId, makeMessage("trigger"))).rejects.toThrow("endIndex");
	});
});
