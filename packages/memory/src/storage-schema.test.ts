import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	createAllTables,
	createEmbeddingMeta,
	createEpisodeTables,
	createFactTables,
	createMessageQueue,
	migrateMemoryDb,
} from "./storage-schema.ts";

interface SqliteMasterRow {
	name: string;
}

function getNames(db: Database, type: string, tblName?: string): string[] {
	const where = tblName
		? `type = '${type}' AND tbl_name = '${tblName}'`
		: `type = '${type}' AND name NOT LIKE 'sqlite_%'`;
	const rows = db
		.prepare(`SELECT name FROM sqlite_master WHERE ${where}`)
		.all() as SqliteMasterRow[];
	return rows.map((r) => r.name);
}

describe("sqlite-schema", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	describe("createEpisodeTables", () => {
		test("creates episodes table", () => {
			createEpisodeTables(db);
			expect(getNames(db, "table")).toContain("episodes");
		});

		test("creates user_id index", () => {
			createEpisodeTables(db);
			expect(getNames(db, "index", "episodes")).toContain("idx_episodes_user_id");
		});

		test("creates FTS5 virtual table", () => {
			createEpisodeTables(db);
			expect(getNames(db, "table")).toContain("episodes_fts");
		});

		test("creates FTS5 sync triggers", () => {
			createEpisodeTables(db);
			const triggers = getNames(db, "trigger", "episodes");
			expect(triggers).toContain("episodes_fts_ai");
			expect(triggers).toContain("episodes_fts_ad");
		});
	});

	describe("createFactTables", () => {
		test("creates semantic_facts table", () => {
			createFactTables(db);
			expect(getNames(db, "table")).toContain("semantic_facts");
		});

		test("creates user_id index", () => {
			createFactTables(db);
			expect(getNames(db, "index", "semantic_facts")).toContain("idx_facts_user_id");
		});

		test("creates FTS5 virtual table", () => {
			createFactTables(db);
			expect(getNames(db, "table")).toContain("semantic_facts_fts");
		});

		test("creates FTS5 sync triggers", () => {
			createFactTables(db);
			const triggers = getNames(db, "trigger", "semantic_facts");
			expect(triggers).toContain("facts_fts_ai");
			expect(triggers).toContain("facts_fts_ad");
		});
	});

	describe("createMessageQueue", () => {
		interface ColumnInfo {
			name: string;
		}

		function getColumnNames(database: Database, table: string): string[] {
			const cols = database.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
			return cols.map((c) => c.name);
		}

		test("creates message_queue table", () => {
			createMessageQueue(db);
			expect(getNames(db, "table")).toContain("message_queue");
		});

		test("creates user_id index", () => {
			createMessageQueue(db);
			expect(getNames(db, "index", "message_queue")).toContain("idx_mq_user_id");
		});

		test("includes author_id column on fresh DB", () => {
			createMessageQueue(db);
			const columns = getColumnNames(db, "message_queue");
			expect(columns).toContain("author_id");
		});

		test("includes all expected columns on fresh DB", () => {
			createMessageQueue(db);
			const columns = getColumnNames(db, "message_queue");
			expect(columns).toEqual(
				expect.arrayContaining([
					"id",
					"user_id",
					"role",
					"content",
					"name",
					"author_id",
					"timestamp",
				]),
			);
		});

		test("is idempotent: running twice does not throw", () => {
			expect(() => {
				createMessageQueue(db);
				createMessageQueue(db);
			}).not.toThrow();
			const columns = getColumnNames(db, "message_queue");
			const authorIdCount = columns.filter((c) => c === "author_id").length;
			expect(authorIdCount).toBe(1);
		});
	});

	describe("migrateMemoryDb", () => {
		interface ColumnInfo {
			name: string;
		}

		function getColumnNames(database: Database, table: string): string[] {
			const cols = database.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
			return cols.map((c) => c.name);
		}

		test("is no-op when message_queue table does not exist", () => {
			expect(() => migrateMemoryDb(db)).not.toThrow();
		});

		test("adds author_id when running on legacy schema (without author_id)", () => {
			// 旧 DB スキーマをシミュレート
			db.exec(`CREATE TABLE message_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
				role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, timestamp INTEGER)`);
			expect(getColumnNames(db, "message_queue")).not.toContain("author_id");

			migrateMemoryDb(db);

			expect(getColumnNames(db, "message_queue")).toContain("author_id");
		});

		test("preserves existing data when adding author_id", () => {
			db.exec(`CREATE TABLE message_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
				role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, timestamp INTEGER)`);
			db.exec(
				"INSERT INTO message_queue (user_id, role, content, name, timestamp) VALUES ('u1', 'user', 'hi', 'Alice', 1000)",
			);

			migrateMemoryDb(db);

			const row = db
				.prepare("SELECT user_id, content, author_id FROM message_queue WHERE user_id = 'u1'")
				.get() as { user_id: string; content: string; author_id: string | null };
			expect(row.user_id).toBe("u1");
			expect(row.content).toBe("hi");
			expect(row.author_id).toBeNull();
		});

		test("is idempotent against legacy schema", () => {
			db.exec(`CREATE TABLE message_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
				role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, timestamp INTEGER)`);
			expect(() => {
				migrateMemoryDb(db);
				migrateMemoryDb(db);
				migrateMemoryDb(db);
			}).not.toThrow();
			const columns = getColumnNames(db, "message_queue");
			expect(columns.filter((c) => c === "author_id").length).toBe(1);
		});

		test("is no-op on fresh DB created by createMessageQueue", () => {
			createMessageQueue(db);
			expect(() => migrateMemoryDb(db)).not.toThrow();
			const columns = getColumnNames(db, "message_queue");
			expect(columns.filter((c) => c === "author_id").length).toBe(1);
		});
	});

	describe("createEmbeddingMeta", () => {
		test("creates embedding_meta table", () => {
			createEmbeddingMeta(db);
			expect(getNames(db, "table")).toContain("embedding_meta");
		});
	});

	describe("createAllTables", () => {
		test("creates all tables", () => {
			createAllTables(db);
			const tables = getNames(db, "table");
			expect(tables).toContain("episodes");
			expect(tables).toContain("episodes_fts");
			expect(tables).toContain("semantic_facts");
			expect(tables).toContain("semantic_facts_fts");
			expect(tables).toContain("message_queue");
			expect(tables).toContain("embedding_meta");
		});

		test("is idempotent", () => {
			expect(() => {
				createAllTables(db);
				createAllTables(db);
			}).not.toThrow();
		});

		test("migrates legacy message_queue schema (author_id added)", () => {
			interface ColumnInfo {
				name: string;
			}
			// 旧 DB に message_queue が author_id なしで存在する状態
			db.exec(`CREATE TABLE message_queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
				role TEXT NOT NULL, content TEXT NOT NULL, name TEXT, timestamp INTEGER)`);

			createAllTables(db);

			const cols = db.prepare("PRAGMA table_info(message_queue)").all() as ColumnInfo[];
			expect(cols.map((c) => c.name)).toContain("author_id");
		});
	});
});
