import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

import { hasColumn } from "@vicissitude/shared/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { buildCreateTablesSql } from "./ddl.ts";
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
 * テーブル作成 DDL。schema.ts（Drizzle 定義）から生成される唯一のソース。
 * migrateDb() の後に実行され、未作成テーブルのみ作成する（既存 DB では no-op）。
 */
export const CREATE_TABLES_SQL = buildCreateTablesSql();

/** テーブルが存在するかチェック */
function hasTable(sqlite: Database, tableName: string): boolean {
	return !!sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
		.get(tableName);
}

/** 既存 DB のマイグレーション（CREATE_TABLES_SQL の前に実行） */
function migrateDb(sqlite: Database): void {
	// event_buffer: guild_id → agent_id リネーム + データ移行
	if (hasTable(sqlite, "event_buffer") && hasColumn(sqlite, "event_buffer", "guild_id")) {
		sqlite.exec("ALTER TABLE event_buffer RENAME COLUMN guild_id TO agent_id");
		sqlite.exec("UPDATE event_buffer SET agent_id = 'discord:' || agent_id");
		sqlite.exec("DROP INDEX IF EXISTS idx_event_buffer_guild");
		sqlite.exec("CREATE INDEX IF NOT EXISTS idx_event_buffer_agent ON event_buffer(agent_id)");
	}

	// mc_session_lock: connected / connected_at カラム追加
	if (hasTable(sqlite, "mc_session_lock")) {
		if (!hasColumn(sqlite, "mc_session_lock", "connected")) {
			sqlite.exec("ALTER TABLE mc_session_lock ADD COLUMN connected INTEGER NOT NULL DEFAULT 0");
		}
		if (!hasColumn(sqlite, "mc_session_lock", "connected_at")) {
			sqlite.exec("ALTER TABLE mc_session_lock ADD COLUMN connected_at INTEGER");
		}
	}

	// agent_heartbeat: rotation_requested_at カラム削除（#632）
	if (
		hasTable(sqlite, "agent_heartbeat") &&
		hasColumn(sqlite, "agent_heartbeat", "rotation_requested_at")
	) {
		sqlite.exec("ALTER TABLE agent_heartbeat DROP COLUMN rotation_requested_at");
	}

	// mc_bridge_events テーブルを削除（統合済み）
	sqlite.exec("DROP TABLE IF EXISTS mc_bridge_events");
	sqlite.exec("DROP INDEX IF EXISTS idx_mc_bridge_direction");
	sqlite.exec("DROP INDEX IF EXISTS idx_mc_bridge_dir_type");
}

export function createDb(dataDir: string): StoreDb {
	mkdirSync(dataDir, { recursive: true });
	const dbPath = join(dataDir, "vicissitude.db");
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec("PRAGMA busy_timeout = 5000");
	migrateDb(sqlite);
	sqlite.exec(CREATE_TABLES_SQL);
	// oxlint-disable-next-line typescript/no-unsafe-argument -- Database インスタンスの型が drizzle の期待する型と一致しない
	const db = drizzle(sqlite, { schema });
	dbInstances.set(db, sqlite);
	return db;
}
