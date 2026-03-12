import { describe, expect, test } from "bun:test";

import { FSRS_CONFIG, retrievability, reviewCard } from "./fsrs.ts";

function makeCard(overrides: Partial<Parameters<typeof retrievability>[0]> = {}) {
	return {
		stability: 1.0,
		difficulty: 0.3,
		lastReviewedAt: null as Date | null,
		...overrides,
	};
}

describe("retrievability", () => {
	test("returns 1.0 when lastReviewedAt is null", () => {
		const card = makeCard();
		expect(retrievability(card)).toBe(1.0);
	});

	test("returns 1.0 when elapsed time is 0", () => {
		const now = new Date();
		const card = makeCard({ lastReviewedAt: now });
		expect(retrievability(card, now)).toBe(1.0);
	});

	test("value decays over time", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const card = makeCard({ lastReviewedAt: reviewed, stability: 1.0 });

		const after1Day = new Date("2026-01-02T00:00:00Z");
		const after7Days = new Date("2026-01-08T00:00:00Z");

		const r1 = retrievability(card, after1Day);
		const r7 = retrievability(card, after7Days);

		expect(r1).toBeLessThan(1.0);
		expect(r7).toBeLessThan(r1);
		expect(r7).toBeGreaterThan(0);
	});

	test("higher stability leads to slower decay", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const after7Days = new Date("2026-01-08T00:00:00Z");

		const lowStability = makeCard({ lastReviewedAt: reviewed, stability: 1.0 });
		const highStability = makeCard({ lastReviewedAt: reviewed, stability: 5.0 });

		const rLow = retrievability(lowStability, after7Days);
		const rHigh = retrievability(highStability, after7Days);

		expect(rHigh).toBeGreaterThan(rLow);
	});

	test("matches expected formula: 1 / (1 + elapsed / (DECAY * stability))", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const after3Days = new Date("2026-01-04T00:00:00Z");
		const card = makeCard({ lastReviewedAt: reviewed, stability: 2.0 });

		const expected = 1 / (1 + 3 / (FSRS_CONFIG.DECAY_FACTOR * 2.0));
		expect(retrievability(card, after3Days)).toBeCloseTo(expected);
	});
});

describe("reviewCard — stability", () => {
	test("rating 'good' preserves stability when retrievability is 1.0", () => {
		const card = makeCard({ lastReviewedAt: null, stability: 2.0 });
		const now = new Date();
		const updated = reviewCard(card, "good", now);
		expect(updated.stability).toBeCloseTo(2.0);
	});

	test("rating 'easy' increases stability", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-04T00:00:00Z");
		const card = makeCard({ lastReviewedAt: reviewed, stability: 2.0 });
		const updated = reviewCard(card, "easy", now);
		expect(updated.stability).toBeGreaterThan(card.stability);
	});

	test("rating 'again' decreases stability", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-04T00:00:00Z");
		const card = makeCard({ lastReviewedAt: reviewed, stability: 2.0 });
		const updated = reviewCard(card, "again", now);
		expect(updated.stability).toBeLessThan(card.stability);
	});

	test("stability never goes below 0.1", () => {
		const reviewed = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-06-01T00:00:00Z");
		const card = makeCard({ lastReviewedAt: reviewed, stability: 0.1 });
		const updated = reviewCard(card, "again", now);
		expect(updated.stability).toBeGreaterThanOrEqual(0.1);
	});

	test("lastReviewedAt is updated to now", () => {
		const now = new Date("2026-03-01T12:00:00Z");
		const card = makeCard();
		const updated = reviewCard(card, "good", now);
		expect(updated.lastReviewedAt).toEqual(now);
	});
});

describe("reviewCard — difficulty", () => {
	test("'again' increases difficulty", () => {
		const card = makeCard({ difficulty: 0.3 });
		const updated = reviewCard(card, "again");
		expect(updated.difficulty).toBe(0.4);
	});

	test("'easy' decreases difficulty", () => {
		const card = makeCard({ difficulty: 0.3 });
		const updated = reviewCard(card, "easy");
		expect(updated.difficulty).toBe(0.25);
	});

	test("'hard' decreases difficulty by 0.05", () => {
		const card = makeCard({ difficulty: 0.3 });
		const updated = reviewCard(card, "hard");
		expect(updated.difficulty).toBe(0.25);
	});

	test("difficulty stays within 0–1 range (clamped at 0)", () => {
		const card = makeCard({ difficulty: 0.02 });
		const updated = reviewCard(card, "easy");
		expect(updated.difficulty).toBeGreaterThanOrEqual(0);
	});

	test("difficulty stays within 0–1 range (clamped at 1)", () => {
		const card = makeCard({ difficulty: 0.98 });
		const updated = reviewCard(card, "again");
		expect(updated.difficulty).toBeLessThanOrEqual(1);
	});
});
