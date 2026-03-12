import { describe, expect, test } from "bun:test";

import { createEpisode } from "./episode.ts";
import type { ChatMessage } from "./types.ts";

const baseParams = () => ({
	userId: "user-1",
	title: "Test Episode",
	summary: "A test episode summary",
	messages: [{ role: "user", content: "hello" }] as ChatMessage[],
	embedding: [0.1, 0.2, 0.3],
	surprise: 0.5,
	startAt: new Date("2026-01-01T00:00:00Z"),
	endAt: new Date("2026-01-01T01:00:00Z"),
});

describe("createEpisode — fields", () => {
	test("returns a valid Episode object with all fields", () => {
		const ep = createEpisode(baseParams());

		expect(ep.userId).toBe("user-1");
		expect(ep.title).toBe("Test Episode");
		expect(ep.summary).toBe("A test episode summary");
		expect(ep.messages).toHaveLength(1);
		expect(ep.embedding).toEqual([0.1, 0.2, 0.3]);
		expect(ep.surprise).toBe(0.5);
		expect(ep.startAt).toEqual(new Date("2026-01-01T00:00:00Z"));
		expect(ep.endAt).toEqual(new Date("2026-01-01T01:00:00Z"));
	});

	test("id is a valid UUID", () => {
		const ep = createEpisode(baseParams());
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		expect(ep.id).toMatch(uuidRegex);
	});

	test("each call generates a unique id", () => {
		const ep1 = createEpisode(baseParams());
		const ep2 = createEpisode(baseParams());
		expect(ep1.id).not.toBe(ep2.id);
	});

	test("lastReviewedAt is null", () => {
		const ep = createEpisode(baseParams());
		expect(ep.lastReviewedAt).toBeNull();
	});

	test("consolidatedAt is null", () => {
		const ep = createEpisode(baseParams());
		expect(ep.consolidatedAt).toBeNull();
	});

	test("createdAt is set to approximately now", () => {
		const before = new Date();
		const ep = createEpisode(baseParams());
		const after = new Date();
		expect(ep.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
		expect(ep.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
	});
});

describe("createEpisode — FSRS defaults", () => {
	test("sets default FSRS parameters (stability and difficulty)", () => {
		const ep = createEpisode(baseParams());
		expect(ep.difficulty).toBe(0.3);
		expect(typeof ep.stability).toBe("number");
		expect(ep.stability).toBeGreaterThan(0);
	});

	test("higher surprise leads to higher initial stability", () => {
		const lowSurprise = createEpisode({ ...baseParams(), surprise: 0.1 });
		const highSurprise = createEpisode({ ...baseParams(), surprise: 0.9 });
		expect(highSurprise.stability).toBeGreaterThan(lowSurprise.stability);
	});

	test("initial stability follows formula: base * (1 + surprise * 2)", () => {
		const ep = createEpisode({ ...baseParams(), surprise: 0.5 });
		const expected = 1.0 + 0.5 * 2.0;
		expect(ep.stability).toBeCloseTo(expected);
	});
});
