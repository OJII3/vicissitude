import type { ChatMessage } from "./types.ts";

/** An episodic memory — a segment of conversation */
export interface Episode {
	id: string;
	userId: string;
	title: string;
	summary: string;
	messages: ChatMessage[];
	embedding: number[];
	surprise: number;
	stability: number;
	difficulty: number;
	startAt: Date;
	endAt: Date;
	createdAt: Date;
	lastReviewedAt: Date | null;
	consolidatedAt: Date | null;
}

/** Parameters for creating a new episode */
export interface CreateEpisodeParams {
	userId: string;
	title: string;
	summary: string;
	messages: ChatMessage[];
	embedding: number[];
	surprise: number;
	startAt: Date;
	endAt: Date;
}

/** Create a new Episode with default FSRS parameters */
export function createEpisode(params: CreateEpisodeParams): Episode {
	return {
		id: crypto.randomUUID(),
		...params,
		stability: initialStability(params.surprise),
		difficulty: 0.3,
		createdAt: new Date(),
		lastReviewedAt: null,
		consolidatedAt: null,
	};
}

/** Initial stability with surprise boost */
function initialStability(surprise: number): number {
	const base = 1.0;
	const boost = 1.0 + surprise * 2.0;
	return base * boost;
}
