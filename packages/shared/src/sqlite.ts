import type { Database } from "bun:sqlite";

const sqliteIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteSqliteIdentifier(identifier: string): string {
	if (!sqliteIdentifierPattern.test(identifier)) {
		throw new Error(`Invalid SQLite identifier: ${identifier}`);
	}
	return `"${identifier}"`;
}

/** テーブル内に指定カラムが存在するかチェック */
export function hasColumn(db: Database, tableName: string, columnName: string): boolean {
	const tableIdentifier = quoteSqliteIdentifier(tableName);
	const columns = db.prepare(`PRAGMA table_info(${tableIdentifier})`).all() as { name: string }[];
	return columns.some((c) => c.name === columnName);
}
