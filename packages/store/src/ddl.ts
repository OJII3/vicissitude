import { SQLiteSyncDialect, getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "./schema.ts";

const dialect = new SQLiteSyncDialect();

/** 単一テーブル分の CREATE TABLE IF NOT EXISTS（+ 付随する CREATE INDEX）を生成する */
function generateTableDdl(table: SQLiteTable): string {
	const cfg = getTableConfig(table);
	const lines: string[] = [];

	for (const col of cfg.columns) {
		const c = col as SQLiteColumn & { primary?: boolean; autoIncrement?: boolean };
		let line = `\t${c.name} ${c.getSQLType().toUpperCase()}`;
		if (c.primary && c.autoIncrement) {
			line += " PRIMARY KEY AUTOINCREMENT";
		} else if (c.primary) {
			line += " PRIMARY KEY";
		}
		if (c.notNull && !c.primary) {
			line += " NOT NULL";
		}
		if (c.default !== undefined) {
			const def = c.default as unknown;
			line += ` DEFAULT ${typeof def === "string" ? `'${def}'` : JSON.stringify(def)}`;
		}
		lines.push(line);
	}

	for (const pk of cfg.primaryKeys) {
		lines.push(`\tPRIMARY KEY (${pk.columns.map((c) => c.name).join(", ")})`);
	}

	for (const ck of cfg.checks) {
		lines.push(`\tCHECK (${dialect.sqlToQuery(ck.value).sql})`);
	}

	let ddl = `CREATE TABLE IF NOT EXISTS ${cfg.name} (\n${lines.join(",\n")}\n);`;

	for (const idx of cfg.indexes) {
		const ic = idx.config;
		const cols = ic.columns.map((c) => (c as { name: string }).name).join(", ");
		ddl += `\nCREATE INDEX IF NOT EXISTS ${ic.name} ON ${cfg.name}(${cols});`;
	}

	return ddl;
}

/**
 * schema.ts の Drizzle 定義から全テーブルの CREATE TABLE IF NOT EXISTS DDL を生成する。
 * schema.ts がスキーマの唯一のソースであり、手書き SQL を持たない。
 */
export function buildCreateTablesSql(): string {
	return Object.values(schema)
		.map((table) => generateTableDdl(table as SQLiteTable))
		.join("\n\n");
}
