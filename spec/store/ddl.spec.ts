import { describe, expect, test } from "bun:test";

import { appendEvent, incrementEmoji } from "@vicissitude/store/queries";
import * as schema from "@vicissitude/store/schema";
import { createTestDb } from "@vicissitude/store/test-helpers";
import { getTableConfig } from "drizzle-orm/sqlite-core";

type ColInfo = { name: string; type: string; notnull: number; pk: number; dflt_value: unknown };

function tableInfo(db: ReturnType<typeof createTestDb>, table: string): ColInfo[] {
	return db.$client.prepare(`PRAGMA table_info(${table})`).all() as ColInfo[];
}

describe("store schema (DDL)", () => {
	test("Drizzle スキーマの全テーブル・カラムが実 DB に存在し型・NOT NULL・PK が一致する", () => {
		const db = createTestDb();
		for (const tbl of Object.values(schema)) {
			const cfg = getTableConfig(tbl);
			const info = tableInfo(db, cfg.name);
			const infoByName = new Map(info.map((c) => [c.name, c]));

			expect(info).toHaveLength(cfg.columns.length);

			const compositePkCols = new Set(
				cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
			);

			for (const col of cfg.columns) {
				const actual = infoByName.get(col.name);
				expect(actual, `${cfg.name}.${col.name} が存在する`).toBeDefined();
				if (!actual) continue;
				expect(actual.type.toUpperCase()).toBe(col.getSQLType().toUpperCase());
				// NOTE: SQLite の仕様で単一カラム PRIMARY KEY は PRAGMA table_info で notnull=0 と報告される。
				// 複合 PK のカラム（composite PK）は notnull=1 と報告される。
				// そのため col.primary=true（単一 PK）の場合はnotnullチェックをスキップする。
				if (!col.primary) {
					expect(Boolean(actual.notnull)).toBe(col.notNull);
				}
				const expectedPk = col.primary || compositePkCols.has(col.name);
				expect(actual.pk > 0, `${cfg.name}.${col.name} の PK`).toBe(expectedPk);
			}
		}
	});

	test("event_buffer に idx_event_buffer_agent インデックスが存在する", () => {
		const db = createTestDb();
		const idxs = db.$client.prepare(`PRAGMA index_list(event_buffer)`).all() as { name: string }[];
		expect(idxs.some((i) => i.name === "idx_event_buffer_agent")).toBe(true);
	});

	test("mc_session_lock は id=1 のみ許可（CHECK 制約）", () => {
		const db = createTestDb();
		expect(() =>
			db.$client
				.prepare("INSERT INTO mc_session_lock (id, guild_id, acquired_at) VALUES (1, 'g', 1)")
				.run(),
		).not.toThrow();
		expect(() =>
			db.$client
				.prepare("INSERT INTO mc_session_lock (id, guild_id, acquired_at) VALUES (2, 'g', 1)")
				.run(),
		).toThrow();
	});

	test("event_buffer.id は AUTOINCREMENT で採番される", () => {
		const db = createTestDb();
		appendEvent(db, "agent-1", "{}");
		appendEvent(db, "agent-1", "{}");
		const rows = db.$client.prepare("SELECT id FROM event_buffer ORDER BY id").all() as {
			id: number;
		}[];
		expect(rows).toHaveLength(2);
		expect(rows[1]?.id).toBeGreaterThan(rows[0]?.id ?? -1);
	});

	test("emoji_usage は (guild_id, emoji_name) 複合 PK で upsert される", () => {
		const db = createTestDb();
		incrementEmoji(db, "g1", "fire");
		incrementEmoji(db, "g1", "fire");
		const count = db.$client
			.prepare("SELECT count FROM emoji_usage WHERE guild_id='g1' AND emoji_name='fire'")
			.get() as { count: number };
		expect(count.count).toBe(2);
	});
});
