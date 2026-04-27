import type { Database } from "bun:sqlite";

/** テーブル内に指定カラムが存在するかチェック（PRAGMA はパラメータバインド非対応のため文字列補間を使用。呼び出し元はリテラルのみ） */
export function hasColumn(db: Database, tableName: string, columnName: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
	return columns.some((c) => c.name === columnName);
}
