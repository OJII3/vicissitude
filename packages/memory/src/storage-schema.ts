import type { Database } from "bun:sqlite";

import { hasColumn } from "@vicissitude/shared/sqlite";

function hasTable(db: Database, tableName: string): boolean {
	return !!db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
		.get(tableName);
}

/** 既存 DB のマイグレーション（CREATE 系より前に実行する） */
export function migrateMemoryDb(db: Database): void {
	// message_queue: author_id カラム追加（#847）
	if (hasTable(db, "message_queue") && !hasColumn(db, "message_queue", "author_id")) {
		db.exec("ALTER TABLE message_queue ADD COLUMN author_id TEXT");
	}
}

export function createEpisodeTables(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS episodes (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
		messages TEXT NOT NULL, embedding TEXT NOT NULL, surprise REAL NOT NULL,
		stability REAL NOT NULL, difficulty REAL NOT NULL, start_at INTEGER NOT NULL,
		end_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_reviewed_at INTEGER,
		consolidated_at INTEGER)`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_user_id ON episodes(user_id)");
	db.exec(
		"CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(id UNINDEXED, title, summary)",
	);
	db.exec(`CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
		INSERT INTO episodes_fts(id, title, summary) VALUES (new.id, new.title, new.summary); END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
		DELETE FROM episodes_fts WHERE id = old.id; END`);
}

export function createFactTables(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS semantic_facts (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL, fact TEXT NOT NULL,
		keywords TEXT NOT NULL, source_episodic_ids TEXT NOT NULL, embedding TEXT NOT NULL,
		valid_at INTEGER NOT NULL, invalid_at INTEGER, created_at INTEGER NOT NULL)`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_facts_user_id ON semantic_facts(user_id)");
	db.exec(
		"CREATE VIRTUAL TABLE IF NOT EXISTS semantic_facts_fts USING fts5(id UNINDEXED, fact, keywords)",
	);
	db.exec(`CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON semantic_facts BEGIN
		INSERT INTO semantic_facts_fts(id, fact, keywords) VALUES (new.id, new.fact, new.keywords); END`);
	db.exec(`CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON semantic_facts BEGIN
		DELETE FROM semantic_facts_fts WHERE id = old.id; END`);
}

export function createMessageQueue(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS message_queue (
		id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
		role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, author_id TEXT, timestamp INTEGER)`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_mq_user_id ON message_queue(user_id)");
}

export function createEmbeddingMeta(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS embedding_meta (
		key TEXT PRIMARY KEY, dimension INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
}

export function createAllTables(db: Database): void {
	migrateMemoryDb(db);
	createEpisodeTables(db);
	createFactTables(db);
	createMessageQueue(db);
	createEmbeddingMeta(db);
}
