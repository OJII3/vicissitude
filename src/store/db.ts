import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.ts";

export type StoreDb = ReturnType<typeof drizzle<typeof schema>>;

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	key TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
	id TEXT PRIMARY KEY,
	guild_id TEXT,
	description TEXT NOT NULL,
	schedule_type TEXT NOT NULL,
	schedule_value TEXT NOT NULL,
	last_executed_at TEXT,
	enabled INTEGER NOT NULL DEFAULT 1
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

CREATE TABLE IF NOT EXISTS heartbeat_config (
	key TEXT PRIMARY KEY DEFAULT 'default',
	base_interval_minutes INTEGER NOT NULL DEFAULT 1
);
`;

export function createDb(dataDir: string): StoreDb {
	mkdirSync(dataDir, { recursive: true });
	const dbPath = join(dataDir, "vicissitude.db");
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec(CREATE_TABLES_SQL);
	return drizzle(sqlite, { schema });
}
