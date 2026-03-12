import type { ReviewRating } from "./types.ts";

/** FSRS card parameters */
export interface FSRSCard {
	stability: number;
	difficulty: number;
	lastReviewedAt: Date | null;
}

/** FSRS configuration constants */
export const FSRS_CONFIG = {
	/** Target retention probability */
	DESIRED_RETENTION: 0.9,
	/** Decay factor for retrievability calculation */
	DECAY_FACTOR: 9,
} as const;

/**
 * Calculate the current retrievability (recall probability) of a memory.
 *
 * Formula: R = (1 + elapsed_days / (DECAY_FACTOR * stability))^(-1)
 *
 * @param card - FSRS card parameters
 * @param now - Current timestamp
 * @returns Retrievability value between 0 and 1
 */
export function retrievability(card: FSRSCard, now: Date = new Date()): number {
	if (card.lastReviewedAt === null) {
		return 1.0;
	}

	const elapsedMs = now.getTime() - card.lastReviewedAt.getTime();
	const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

	if (elapsedDays <= 0) {
		return 1.0;
	}

	return 1 / (1 + elapsedDays / (FSRS_CONFIG.DECAY_FACTOR * card.stability));
}

/** Review rating multipliers for stability update */
const RATING_MULTIPLIERS: Record<ReviewRating, number> = {
	again: 0.5,
	hard: 0.8,
	good: 1.0,
	easy: 1.3,
};

/**
 * Update FSRS card parameters after a review.
 *
 * @param card - Current card parameters
 * @param rating - Review rating
 * @param now - Current timestamp
 * @returns Updated card parameters
 */
export function reviewCard(card: FSRSCard, rating: ReviewRating, now: Date = new Date()): FSRSCard {
	const r = retrievability(card, now);
	const multiplier = RATING_MULTIPLIERS[rating];

	const newStability = card.stability * (1 + (multiplier - 1) * (1 - r));
	const newDifficulty = Math.max(
		0,
		Math.min(1, card.difficulty + (rating === "again" ? 0.1 : -0.05)),
	);

	return {
		stability: Math.max(0.1, newStability),
		difficulty: newDifficulty,
		lastReviewedAt: now,
	};
}
