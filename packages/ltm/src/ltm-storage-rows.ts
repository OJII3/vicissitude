import type { Episode } from "./episode.ts";
import {
	parseJson,
	validateCategory,
	validateEmbedding,
	validateMessages,
	validateRole,
	validateStringArray,
} from "./parse-helpers.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import type { ChatMessage } from "./types.ts";

export interface EpisodeRow {
	id: string;
	user_id: string;
	title: string;
	summary: string;
	messages: string;
	embedding: string;
	surprise: number;
	stability: number;
	difficulty: number;
	start_at: number;
	end_at: number;
	created_at: number;
	last_reviewed_at: number | null;
	consolidated_at: number | null;
}

export function rowToEpisode(row: EpisodeRow): Episode {
	return {
		id: row.id,
		userId: row.user_id,
		title: row.title,
		summary: row.summary,
		messages: validateMessages(parseJson(row.messages, "messages")),
		embedding: validateEmbedding(parseJson(row.embedding, "embedding")),
		surprise: row.surprise,
		stability: row.stability,
		difficulty: row.difficulty,
		startAt: new Date(row.start_at),
		endAt: new Date(row.end_at),
		createdAt: new Date(row.created_at),
		lastReviewedAt: row.last_reviewed_at === null ? null : new Date(row.last_reviewed_at),
		consolidatedAt: row.consolidated_at === null ? null : new Date(row.consolidated_at),
	};
}

export interface FactRow {
	id: string;
	user_id: string;
	category: string;
	fact: string;
	keywords: string;
	source_episodic_ids: string;
	embedding: string;
	valid_at: number;
	invalid_at: number | null;
	created_at: number;
}

export function rowToFact(row: FactRow): SemanticFact {
	return {
		id: row.id,
		userId: row.user_id,
		category: validateCategory(row.category),
		fact: row.fact,
		keywords: validateStringArray(parseJson(row.keywords, "keywords"), "keywords", 100),
		sourceEpisodicIds: validateStringArray(
			parseJson(row.source_episodic_ids, "source_episodic_ids"),
			"source_episodic_ids",
			500,
		),
		embedding: validateEmbedding(parseJson(row.embedding, "embedding")),
		validAt: new Date(row.valid_at),
		invalidAt: row.invalid_at === null ? null : new Date(row.invalid_at),
		createdAt: new Date(row.created_at),
	};
}

export interface MessageRow {
	role: string;
	content: string;
	name: string | null;
	timestamp: number | null;
}

export function rowToMessage(row: MessageRow): ChatMessage {
	return {
		role: validateRole(row.role),
		content: row.content,
		...(row.name === null ? {} : { name: row.name }),
		...(row.timestamp === null ? {} : { timestamp: new Date(row.timestamp) }),
	};
}
