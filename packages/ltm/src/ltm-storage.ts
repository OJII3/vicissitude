/* oxlint-disable max-lines, require-await, no-await-in-loop -- storage methods are async for API compatibility */
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

/** Check if an error is an FTS5 query parse/match error (safe to fallback to LIKE) */
function isFts5Error(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return msg.includes("fts5") || msg.includes("match") || msg.includes("no such table");
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
	/** undefined = not loaded yet */
	private cachedDimension: number | null | undefined = undefined;

	constructor(path = ":memory:") {
		this.db = new Database(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		createAllTables(this.db);
	}

	close(): void {
		this.db.close();
	}

	private loadDimension(): number | null {
		if (this.cachedDimension !== undefined) return this.cachedDimension;
		const row = this.db
			.prepare("SELECT dimension FROM embedding_meta WHERE key = 'default'")
			.get() as { dimension: number } | null;
		if (row) {
			this.cachedDimension = row.dimension;
			return this.cachedDimension;
		}
		// Backfill from existing data for DBs created before embedding_meta was added
		const dim = this.inferDimensionFromExistingData();
		if (dim !== null) {
			this.upsertDimension(dim);
			return dim;
		}
		this.cachedDimension = null;
		return null;
	}

	/** Sample one existing embedding to infer the dimension stored in this DB */
	private inferDimensionFromExistingData(): number | null {
		const episode = this.db.prepare("SELECT embedding FROM episodes LIMIT 1").get() as {
			embedding: string;
		} | null;
		if (episode) {
			const parsed = JSON.parse(episode.embedding) as number[];
			if (parsed.length > 0) return parsed.length;
		}
		const fact = this.db
			.prepare("SELECT embedding FROM semantic_facts WHERE invalid_at IS NULL LIMIT 1")
			.get() as { embedding: string } | null;
		if (fact) {
			const parsed = JSON.parse(fact.embedding) as number[];
			if (parsed.length > 0) return parsed.length;
		}
		return null;
	}

	/**
	 * Atomically insert or read the dimension. Uses INSERT OR IGNORE to handle
	 * concurrent writers safely, then re-reads to get the winner's value.
	 */
	private upsertDimension(dimension: number): void {
		this.db
			.prepare("INSERT OR IGNORE INTO embedding_meta (key, dimension, created_at) VALUES (?, ?, ?)")
			.run("default", dimension, Date.now());
		// Re-read to get the actual stored value (may differ if another writer won)
		const row = this.db
			.prepare("SELECT dimension FROM embedding_meta WHERE key = 'default'")
			.get() as { dimension: number };
		this.cachedDimension = row.dimension;
	}

	/**
	 * Validate and register embedding dimension for write operations (save/update).
	 * On first call, records the dimension (backfilling from existing data if present).
	 * On subsequent calls, throws if dimension differs.
	 */
	private validateEmbeddingDimensionForWrite(embedding: number[]): void {
		if (embedding.length === 0) return;

		const stored = this.loadDimension();

		if (stored === null) {
			this.upsertDimension(embedding.length);
			if (this.cachedDimension !== embedding.length) {
				throw new Error(
					`Embedding dimension mismatch: expected ${this.cachedDimension}, got ${embedding.length}. ` +
						"If you changed the embedding model, run the re-embedding migration (see RUNBOOK.md).",
				);
			}
			return;
		}

		if (stored !== embedding.length) {
			throw new Error(
				`Embedding dimension mismatch: expected ${stored}, got ${embedding.length}. ` +
					"If you changed the embedding model, run the re-embedding migration (see RUNBOOK.md).",
			);
		}
	}

	/**
	 * Check embedding dimension for read operations (search).
	 * Only validates if dimension is already known; never creates embedding_meta.
	 */
	private checkEmbeddingDimensionForRead(embedding: number[]): void {
		if (embedding.length === 0) return;

		const stored = this.loadDimension();
		if (stored !== null && stored !== embedding.length) {
			throw new Error(
				`Embedding dimension mismatch: expected ${stored}, got ${embedding.length}. ` +
					"If you changed the embedding model, run the re-embedding migration (see RUNBOOK.md).",
			);
		}
	}

	getEmbeddingDimension(): number | null {
		return this.loadDimension();
	}

	resetEmbeddingMeta(): void {
		this.db.prepare("DELETE FROM embedding_meta WHERE key = 'default'").run();
		this.cachedDimension = undefined;
	}

	async saveEpisode(userId: string, episode: Episode): Promise<void> {
		if (episode.userId !== userId) {
			throw new Error("episode.userId does not match userId");
		}
		this.validateEmbeddingDimensionForWrite(episode.embedding);
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
		this.validateEmbeddingDimensionForWrite(fact.embedding);
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
		if (updates.embedding) {
			this.validateEmbeddingDimensionForWrite(updates.embedding);
		}
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
		} catch (err) {
			if (!isFts5Error(err)) throw err;
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
		} catch (err) {
			if (!isFts5Error(err)) throw err;
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
		this.checkEmbeddingDimensionForRead(embedding);
		const lim = clampLimit(limit);
		// Fetch only id + embedding for similarity ranking, then load full rows for top-N
		const candidates = this.db
			.prepare("SELECT id, embedding FROM episodes WHERE user_id = ?")
			.all(userId) as Pick<EpisodeRow, "id" | "embedding">[];
		const topIds = sortBySimilarity(
			candidates.map((r) => ({ id: r.id, embedding: JSON.parse(r.embedding) as number[] })),
			embedding,
			lim,
		).map((r) => r.id);
		if (topIds.length === 0) return [];
		const placeholders = topIds.map(() => "?").join(",");
		const rows = this.db
			.prepare(`SELECT * FROM episodes WHERE id IN (${placeholders}) AND user_id = ?`)
			.all(...topIds, userId) as EpisodeRow[];
		return sortBySimilarity(
			rows.map((r) => rowToEpisode(r)),
			embedding,
			lim,
		);
	}

	async searchFactsByEmbedding(
		userId: string,
		embedding: number[],
		limit: number,
	): Promise<SemanticFact[]> {
		this.checkEmbeddingDimensionForRead(embedding);
		const lim = clampLimit(limit);
		const candidates = this.db
			.prepare("SELECT id, embedding FROM semantic_facts WHERE user_id = ? AND invalid_at IS NULL")
			.all(userId) as Pick<FactRow, "id" | "embedding">[];
		const topIds = sortBySimilarity(
			candidates.map((r) => ({ id: r.id, embedding: JSON.parse(r.embedding) as number[] })),
			embedding,
			lim,
		).map((r) => r.id);
		if (topIds.length === 0) return [];
		const placeholders = topIds.map(() => "?").join(",");
		const rows = this.db
			.prepare(`SELECT * FROM semantic_facts WHERE id IN (${placeholders}) AND user_id = ?`)
			.all(...topIds, userId) as FactRow[];
		return sortBySimilarity(
			rows.map((r) => rowToFact(r)),
			embedding,
			lim,
		);
	}
}
