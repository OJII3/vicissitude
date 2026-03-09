import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.ts";

export type StoreDb = ReturnType<typeof drizzle<typeof schema>>;

const dbInstances = new WeakMap<StoreDb, Database>();

/** Close the underlying SQLite database, flushing WAL checkpoint */
export function closeDb(db: StoreDb): void {
	const sqlite = dbInstances.get(db);
	if (sqlite) {
		try {
			sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// WAL checkpoint may fail if DB is in an error state; proceed with close
		}
		try {
			sqlite.close();
		} catch {
			// close may fail if already closed
		}
		dbInstances.delete(db);
	}
}

/**
 * NOTE: この SQL と store/schema.ts の Drizzle スキーマ定義は常に同期させること。
 * カラム追加・変更時は両方を更新する必要がある。
 */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	key TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emoji_usage (
	guild_id TEXT NOT NULL,
	emoji_name TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (guild_id, emoji_name)
);

CREATE TABLE IF NOT EXISTS event_buffer (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	guild_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_buffer_guild ON event_buffer(guild_id);

CREATE TABLE IF NOT EXISTS mc_bridge_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	direction TEXT NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mc_bridge_direction ON mc_bridge_events(direction, consumed);
`;

export function createDb(dataDir: string): StoreDb {
	mkdirSync(dataDir, { recursive: true });
	const dbPath = join(dataDir, "vicissitude.db");
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA busy_timeout = 5000");
	sqlite.exec(CREATE_TABLES_SQL);
	const db = drizzle(sqlite, { schema });
	dbInstances.set(db, sqlite);
	return db;
}
