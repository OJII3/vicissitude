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
	agent_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_buffer_agent ON event_buffer(agent_id);

CREATE TABLE IF NOT EXISTS mc_session_lock (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	guild_id TEXT NOT NULL,
	acquired_at INTEGER NOT NULL,
	connected INTEGER NOT NULL DEFAULT 0,
	connected_at INTEGER
);
`;

/** 既存 DB を新スキーマにマイグレーションする */
function migrateDb(sqlite: Database): void {
	// event_buffer: guild_id → agent_id リネーム + 既存データを discord:{guild_id} に変換
	const hasGuildIdColumn = sqlite
		.prepare(
			"SELECT COUNT(*) as cnt FROM pragma_table_info('event_buffer') WHERE name = 'guild_id'",
		)
		.get() as { cnt: number } | null;
	if (hasGuildIdColumn && hasGuildIdColumn.cnt > 0) {
		sqlite.exec("ALTER TABLE event_buffer RENAME COLUMN guild_id TO agent_id");
		sqlite.exec(
			"UPDATE event_buffer SET agent_id = 'discord:' || agent_id WHERE agent_id NOT LIKE '%:%'",
		);
		// 古いインデックスを削除して新しいインデックスを作成
		sqlite.exec("DROP INDEX IF EXISTS idx_event_buffer_guild");
	}

	// mc_session_lock: connected, connected_at カラム追加（テーブルが存在する場合のみ）
	const mcLockTableExists = sqlite
		.prepare(
			"SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='mc_session_lock'",
		)
		.get() as { cnt: number } | null;
	if (mcLockTableExists && mcLockTableExists.cnt > 0) {
		const hasConnectedColumn = sqlite
			.prepare(
				"SELECT COUNT(*) as cnt FROM pragma_table_info('mc_session_lock') WHERE name = 'connected'",
			)
			.get() as { cnt: number } | null;
		if (hasConnectedColumn && hasConnectedColumn.cnt === 0) {
			sqlite.exec("ALTER TABLE mc_session_lock ADD COLUMN connected INTEGER NOT NULL DEFAULT 0");
			sqlite.exec("ALTER TABLE mc_session_lock ADD COLUMN connected_at INTEGER");
		}
	}

	// mc_bridge_events: 不要になったテーブルを削除
	sqlite.exec("DROP TABLE IF EXISTS mc_bridge_events");
}

export function createDb(dataDir: string): StoreDb {
	mkdirSync(dataDir, { recursive: true });
	const dbPath = join(dataDir, "vicissitude.db");
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA busy_timeout = 5000");
	migrateDb(sqlite);
	sqlite.exec(CREATE_TABLES_SQL);
	const db = drizzle(sqlite, { schema });
	dbInstances.set(db, sqlite);
	return db;
}
