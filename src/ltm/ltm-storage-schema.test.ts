import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	createAllTables,
	createEpisodeTables,
	createFactTables,
	createMessageQueue,
} from "./ltm-storage-schema.ts";

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
		test("creates message_queue table", () => {
			createMessageQueue(db);
			expect(getNames(db, "table")).toContain("message_queue");
		});

		test("creates user_id index", () => {
			createMessageQueue(db);
			expect(getNames(db, "index", "message_queue")).toContain("idx_mq_user_id");
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
		});

		test("is idempotent", () => {
			expect(() => {
				createAllTables(db);
				createAllTables(db);
			}).not.toThrow();
		});
	});
});
