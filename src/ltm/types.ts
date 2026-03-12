/** Valid message roles */
export const MESSAGE_ROLES = ["system", "user", "assistant"] as const;

/** Message role in a conversation */
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** A single chat message */
export interface ChatMessage {
	role: MessageRole;
	content: string;
	/** Display name of the speaker (e.g. participant name in multi-person conversations) */
	name?: string;
	timestamp?: Date;
}

/** Valid fact categories */
export const FACT_CATEGORIES = [
	"identity",
	"preference",
	"interest",
	"personality",
	"relationship",
	"experience",
	"goal",
	"guideline",
] as const;

/** Category for semantic facts */
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** Surprise level from event segmentation */
export type SurpriseLevel = "low" | "high" | "extremely_high";

/** Surprise level numeric values */
export const SURPRISE_VALUES: Record<SurpriseLevel, number> = {
	low: 0.2,
	high: 0.6,
	extremely_high: 0.9,
};

/** FSRS review rating */
export type ReviewRating = "again" | "hard" | "good" | "easy";

/** Valid consolidation actions */
export const CONSOLIDATION_ACTIONS = ["new", "reinforce", "update", "invalidate"] as const;

/** Consolidation action for semantic facts */
export type ConsolidationAction = (typeof CONSOLIDATION_ACTIONS)[number];
