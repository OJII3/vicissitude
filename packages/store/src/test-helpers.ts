import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { CREATE_TABLES_SQL, type StoreDb } from "./db.ts";
import * as schema from "./schema.ts";

/** テスト用のインメモリ SQLite DB を生成する（CREATE_TABLES_SQL を db.ts と共有） */
export function createTestDb(): StoreDb {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec(CREATE_TABLES_SQL);
	// oxlint-disable-next-line typescript/no-unsafe-argument -- Database インスタンスの型が drizzle の期待する型と一致しない
	return drizzle(sqlite, { schema });
}
