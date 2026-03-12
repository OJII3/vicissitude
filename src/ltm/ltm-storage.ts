/* oxlint-disable require-await, no-await-in-loop -- storage methods are async for API compatibility */
import { Database } from "bun:sqlite";

import type { Episode } from "./episode.ts";
import type { FSRSCard } from "./fsrs.ts";
import type { EpisodeRow, FactRow, MessageRow } from "./ltm-storage-rows.ts";
import { rowToEpisode, rowToFact, rowToMessage } from "./ltm-storage-rows.ts";
import { createAllTables } from "./ltm-storage-schema.ts";
import type { SemanticFact } from "./semantic-fact.ts";
import type { ChatMessage, FactCategory } from "./types.ts";
import { cosineSimilarity } from "./vector-math.ts";

function escapeLike(s: string): string {
	return s
		.replaceAll("\\", String.raw`\\`)
		.replaceAll("%", String.raw`\%`)
		.replaceAll("_", String.raw`\_`);
}

function escapeFts5(query: string): string {
	const sanitized = query.replaceAll("\0", "");
	return `"${sanitized.replaceAll('"', '""')}"`;
}

function clampLimit(limit: number): number {
	return Math.max(1, Math.min(limit, 1000));
}

function sortBySimilarity<T extends { embedding: number[] }>(
	items: T[],
	query: number[],
	limit: number,
): T[] {
	return items
		.map((item) => ({ item, sim: cosineSimilarity(query, item.embedding) }))
		.toSorted((a, b) => b.sim - a.sim)
		.slice(0, limit)
		.map((r) => r.item);
}

/** SQLite-based LTM storage */
export class LtmStorage {
	private db: Database;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		createAllTables(this.db);
	}

	close(): void {
		this.db.close();
	}

	async saveEpisode(userId: string, episode: Episode): Promise<void> {
		if (episode.userId !== userId) {
			throw new Error("episode.userId does not match userId");
		}
		this.db
			.prepare(
				`INSERT INTO episodes (id, user_id, title, summary, messages, embedding, surprise, stability, difficulty, start_at, end_at, created_at, last_reviewed_at, consolidated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				episode.id,
				episode.userId,
				episode.title,
				episode.summary,
				JSON.stringify(episode.messages),
				JSON.stringify(episode.embedding),
				episode.surprise,
				episode.stability,
				episode.difficulty,
				episode.startAt.getTime(),
				episode.endAt.getTime(),
				episode.createdAt.getTime(),
				episode.lastReviewedAt?.getTime() ?? null,
				episode.consolidatedAt?.getTime() ?? null,
			);
	}

	async getEpisodes(userId: string): Promise<Episode[]> {
		const rows = this.db
			.prepare("SELECT * FROM episodes WHERE user_id = ?")
			.all(userId) as EpisodeRow[];
		return rows.map((r) => rowToEpisode(r));
	}

	async getEpisodeById(userId: string, episodeId: string): Promise<Episode | null> {
		const row = this.db
			.prepare("SELECT * FROM episodes WHERE id = ? AND user_id = ?")
			.get(episodeId, userId) as EpisodeRow | null;
		return row ? rowToEpisode(row) : null;
	}

	async getUnconsolidatedEpisodes(userId: string): Promise<Episode[]> {
		const rows = this.db
			.prepare("SELECT * FROM episodes WHERE user_id = ? AND consolidated_at IS NULL")
			.all(userId) as EpisodeRow[];
		return rows.map((r) => rowToEpisode(r));
	}

	async updateEpisodeFSRS(userId: string, episodeId: string, card: FSRSCard): Promise<void> {
		this.db
			.prepare(
				"UPDATE episodes SET stability = ?, difficulty = ?, last_reviewed_at = ? WHERE id = ? AND user_id = ?",
			)
			.run(
				card.stability,
				card.difficulty,
				card.lastReviewedAt?.getTime() ?? null,
				episodeId,
				userId,
			);
	}

	async markEpisodeConsolidated(userId: string, episodeId: string): Promise<void> {
		this.db
			.prepare("UPDATE episodes SET consolidated_at = ? WHERE id = ? AND user_id = ?")
			.run(Date.now(), episodeId, userId);
	}

	async saveFact(userId: string, fact: SemanticFact): Promise<void> {
		if (fact.userId !== userId) {
			throw new Error("fact.userId does not match userId");
		}
		this.db
			.prepare(
				`INSERT INTO semantic_facts (id, user_id, category, fact, keywords, source_episodic_ids, embedding, valid_at, invalid_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				fact.id,
				fact.userId,
				fact.category,
				fact.fact,
				JSON.stringify(fact.keywords),
				JSON.stringify(fact.sourceEpisodicIds),
				JSON.stringify(fact.embedding),
				fact.validAt.getTime(),
				fact.invalidAt?.getTime() ?? null,
				fact.createdAt.getTime(),
			);
	}

	async getFacts(userId: string): Promise<SemanticFact[]> {
		const rows = this.db
			.prepare("SELECT * FROM semantic_facts WHERE user_id = ? AND invalid_at IS NULL")
			.all(userId) as FactRow[];
		return rows.map((r) => rowToFact(r));
	}

	async getFactsByCategory(userId: string, category: FactCategory): Promise<SemanticFact[]> {
		const rows = this.db
			.prepare(
				"SELECT * FROM semantic_facts WHERE user_id = ? AND category = ? AND invalid_at IS NULL",
			)
			.all(userId, category) as FactRow[];
		return rows.map((r) => rowToFact(r));
	}

	async invalidateFact(userId: string, factId: string, invalidAt: Date): Promise<void> {
		this.db
			.prepare("UPDATE semantic_facts SET invalid_at = ? WHERE id = ? AND user_id = ?")
			.run(invalidAt.getTime(), factId, userId);
	}

	async updateFact(
		userId: string,
		factId: string,
		updates: Partial<Omit<SemanticFact, "id" | "userId">>,
	): Promise<void> {
		const row = this.db
			.prepare("SELECT * FROM semantic_facts WHERE id = ? AND user_id = ?")
			.get(factId, userId) as FactRow | null;
		if (!row) {
			return;
		}

		const original = rowToFact(row);
		const merged = { ...original, ...updates, id: original.id, userId: original.userId };
		this.db
			.prepare(
				`UPDATE semantic_facts SET user_id = ?, category = ?, fact = ?, keywords = ?, source_episodic_ids = ?, embedding = ?, valid_at = ?, invalid_at = ?, created_at = ? WHERE id = ? AND user_id = ?`,
			)
			.run(
				merged.userId,
				merged.category,
				merged.fact,
				JSON.stringify(merged.keywords),
				JSON.stringify(merged.sourceEpisodicIds),
				JSON.stringify(merged.embedding),
				merged.validAt.getTime(),
				merged.invalidAt?.getTime() ?? null,
				merged.createdAt.getTime(),
				factId,
				userId,
			);
	}

	async pushMessage(userId: string, message: ChatMessage): Promise<void> {
		this.db
			.prepare(
				"INSERT INTO message_queue (user_id, role, content, name, timestamp) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				userId,
				message.role,
				message.content,
				message.name ?? null,
				message.timestamp?.getTime() ?? null,
			);
	}

	async getMessageQueue(userId: string): Promise<ChatMessage[]> {
		const rows = this.db
			.prepare(
				"SELECT role, content, name, timestamp FROM message_queue WHERE user_id = ? ORDER BY id ASC",
			)
			.all(userId) as MessageRow[];
		return rows.map((r) => rowToMessage(r));
	}

	async clearMessageQueue(userId: string): Promise<void> {
		this.db.prepare("DELETE FROM message_queue WHERE user_id = ?").run(userId);
	}

	async searchEpisodes(userId: string, query: string, limit: number): Promise<Episode[]> {
		const lim = clampLimit(limit);
		try {
			const rows = this.db
				.prepare(
					`SELECT e.* FROM episodes e JOIN episodes_fts ON episodes_fts.id = e.id WHERE episodes_fts MATCH ? AND e.user_id = ? ORDER BY bm25(episodes_fts) LIMIT ?`,
				)
				.all(escapeFts5(query), userId, lim) as EpisodeRow[];
			return rows.map((r) => rowToEpisode(r));
		} catch {
			const p = `%${escapeLike(query)}%`;
			const rows = this.db
				.prepare(
					`SELECT * FROM episodes WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' COLLATE NOCASE OR summary LIKE ? ESCAPE '\\' COLLATE NOCASE) LIMIT ?`,
				)
				.all(userId, p, p, lim) as EpisodeRow[];
			return rows.map((r) => rowToEpisode(r));
		}
	}

	async searchFacts(userId: string, query: string, limit: number): Promise<SemanticFact[]> {
		const lim = clampLimit(limit);
		try {
			const rows = this.db
				.prepare(
					`SELECT f.* FROM semantic_facts f JOIN semantic_facts_fts ON semantic_facts_fts.id = f.id WHERE semantic_facts_fts MATCH ? AND f.user_id = ? AND f.invalid_at IS NULL ORDER BY bm25(semantic_facts_fts) LIMIT ?`,
				)
				.all(escapeFts5(query), userId, lim) as FactRow[];
			return rows.map((r) => rowToFact(r));
		} catch {
			const p = `%${escapeLike(query)}%`;
			const rows = this.db
				.prepare(
					`SELECT * FROM semantic_facts WHERE user_id = ? AND invalid_at IS NULL AND (fact LIKE ? ESCAPE '\\' COLLATE NOCASE OR keywords LIKE ? ESCAPE '\\' COLLATE NOCASE) LIMIT ?`,
				)
				.all(userId, p, p, lim) as FactRow[];
			return rows.map((r) => rowToFact(r));
		}
	}

	async searchEpisodesByEmbedding(
		userId: string,
		embedding: number[],
		limit: number,
	): Promise<Episode[]> {
		const episodes = (
			this.db.prepare("SELECT * FROM episodes WHERE user_id = ?").all(userId) as EpisodeRow[]
		).map((r) => rowToEpisode(r));
		return sortBySimilarity(episodes, embedding, clampLimit(limit));
	}

	async searchFactsByEmbedding(
		userId: string,
		embedding: number[],
		limit: number,
	): Promise<SemanticFact[]> {
		const facts = (
			this.db
				.prepare("SELECT * FROM semantic_facts WHERE user_id = ? AND invalid_at IS NULL")
				.all(userId) as FactRow[]
		).map((r) => rowToFact(r));
		return sortBySimilarity(facts, embedding, clampLimit(limit));
	}
}
