# store スキーマ単一ソース化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/store/src/db.ts` の手書き `CREATE_TABLES_SQL` を廃し、Drizzle スキーマ（`schema.ts`）を唯一のソースとして `CREATE TABLE IF NOT EXISTS` DDL をランタイム生成する。手書き SQL ⇔ Drizzle の二重定義（「手動同期必須」コメント付き）を解消する。

**Architecture:** `drizzle-orm/sqlite-core` の `getTableConfig` でスキーマを introspect し、`SQLiteSyncDialect` で CHECK 式をレンダリングして DDL 文字列を組み立てる新モジュール `ddl.ts` を追加。`db.ts` の `CREATE_TABLES_SQL` は `buildCreateTablesSql()` の戻り値に置換（export 名は不変なので `test-helpers.ts` は無変更）。**データを触る `migrateDb()` は一切変更しない**（自動生成不可な手続きマイグレーションのため温存）。live DB は既存テーブルがあり `CREATE TABLE IF NOT EXISTS` は no-op なので影響なし。

**Tech Stack:** Bun, bun:sqlite, drizzle-orm 0.45.1（`getTableConfig` / `SQLiteSyncDialect` は既存依存。新規依存なし）, TypeScript。

**前提（プロトタイプで実証済みの事実）:**

- `getTableConfig(table)` から `columns`（`name` / `getSQLType()` → `"text"|"integer"|"real"` / `notNull` / `primary` / `autoIncrement` / `default`）、`primaryKeys`（複合PK）、`indexes`、`checks` が取得できる。
- 現行 `schema.ts` には **index と CHECK が未定義**。生成器が現行 SQL を再現するには 2 つ追加が必須:
  - `eventBuffer` に `index("idx_event_buffer_agent").on(agentId)`
  - `mcSessionLock` に `check("mc_session_lock_single_row", sql\`id = 1\`)`
- 単一カラム PK は drizzle で `primary:true`（inline `PRIMARY KEY`）、複合 PK は `cfg.primaryKeys`（table-level `PRIMARY KEY (a, b)`）として出る。
- `integer().primaryKey()` は `hasDefault:true` だが `default` は `undefined` → **`default !== undefined` のときだけ `DEFAULT` を出力**すれば余計な DEFAULT を付けない（id 列に DEFAULT を付けてはいけない）。
- **検証結果**: 生成 DDL と現行 `CREATE_TABLES_SQL` を別々のインメモリ DB に適用し、全7テーブルの `PRAGMA table_info` + `PRAGMA index_list`/`index_info` が **バイト一致**。CHECK 挙動（id=2 拒否）も一致。唯一の差は `sqlite_master.sql` に保存される CHECK テキスト（生成: table-level `CHECK ("mc_session_lock"."id" = 1)` / 旧: inline `CHECK (id = 1)`）だが **機能的に同一**で PRAGMA・挙動には影響しない。

**ファイル構成:**

| ファイル | 責務 |
| --- | --- |
| `packages/store/src/schema.ts` | Drizzle スキーマ（唯一のソース）。index/check を追加 |
| `packages/store/src/ddl.ts` | **新規**。`buildCreateTablesSql()` — schema から DDL 生成 |
| `packages/store/src/db.ts` | `CREATE_TABLES_SQL` を生成結果に置換。`migrateDb` は不変 |
| `spec/store/ddl.spec.ts` | **新規**。スキーマ契約（カラム/制約/index）の公開契約テスト |

---

## Task 1: スキーマ契約を固定する spec を追加（リファクタの安全網）

このタスクは**現行の legacy `CREATE_TABLES_SQL` 実装に対して green になる**契約テストを先に用意する。Task 2 のリファクタ後も同じ spec が green であることで「スキーマが変わっていない」ことを保証する（プロジェクト規約: `*.spec.ts` は公開契約・リファクタで壊れてはいけない）。

**Files:**
- Create: `spec/store/ddl.spec.ts`

- [ ] **Step 1: 契約 spec を作成**

`spec/store/ddl.spec.ts` を作成する。`getTableConfig`（schema.ts 由来）から期待カラムを導出して実 DB の `PRAGMA table_info` と突き合わせ、index 存在と制約挙動（CHECK / AUTOINCREMENT / 複合PK）を検証する。schema.ts を単一ソースとして参照するので二重定義にならない。

```ts
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

			// 列数一致
			expect(info).toHaveLength(cfg.columns.length);

			const compositePkCols = new Set(
				cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
			);

			for (const col of cfg.columns) {
				const actual = infoByName.get(col.name);
				expect(actual, `${cfg.name}.${col.name} が存在する`).toBeDefined();
				if (!actual) continue;
				// SQLite type affinity は大文字小文字無視だが、生成器は大文字で出す
				expect(actual.type.toUpperCase()).toBe(col.getSQLType().toUpperCase());
				expect(Boolean(actual.notnull)).toBe(col.notNull);
				const expectedPk = col.primary || compositePkCols.has(col.name);
				expect(actual.pk > 0, `${cfg.name}.${col.name} の PK`).toBe(expectedPk);
			}
		}
	});

	test("event_buffer に idx_event_buffer_agent インデックスが存在する", () => {
		const db = createTestDb();
		const idxs = db.$client
			.prepare(`PRAGMA index_list(event_buffer)`)
			.all() as { name: string }[];
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
		const rows = db.$client
			.prepare("SELECT id FROM event_buffer ORDER BY id")
			.all() as { id: number }[];
		expect(rows).toHaveLength(2);
		expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
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
```

- [ ] **Step 2: spec が現行実装で green になることを確認**

Run: `nr test:spec spec/store/ddl.spec.ts` （または `bun test spec/store/ddl.spec.ts`）
Expected: 全 pass。これは現行の legacy `CREATE_TABLES_SQL` 実装に対する契約の固定。

> 補足: `@vicissitude/store/schema` が package exports にあることは確認済み（`./schema`）。`db.$client` は drizzle bun-sqlite の生 `Database`。`PRAGMA index_list` の `name` 列を使う。

- [ ] **Step 3: フォーマットと検証**

Run: `nr fmt && nr validate`
Expected: 0 error。

- [ ] **Step 4: コミット**

```bash
git add spec/store/ddl.spec.ts
git commit -m "test(store): スキーマ契約を固定する ddl spec を追加する"
```

---

## Task 2: Drizzle から DDL を生成し、手書き CREATE_TABLES_SQL を廃止

**Files:**
- Modify: `packages/store/src/schema.ts`（index/check 追加）
- Create: `packages/store/src/ddl.ts`（生成器）
- Modify: `packages/store/src/db.ts`（生成結果へ置換、`migrateDb` は不変）

- [ ] **Step 1: schema.ts に index と check を追加**

`packages/store/src/schema.ts` の import 行を次に変更:

```ts
// before
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
// after
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
```

`eventBuffer` 定義に第3引数（index）を追加:

```ts
// before
export const eventBuffer = sqliteTable("event_buffer", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	agentId: text("agent_id").notNull(),
	payload: text("payload").notNull(),
	createdAt: integer("created_at").notNull(),
});
// after
export const eventBuffer = sqliteTable(
	"event_buffer",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		agentId: text("agent_id").notNull(),
		payload: text("payload").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [index("idx_event_buffer_agent").on(table.agentId)],
);
```

`mcSessionLock` 定義に第3引数（check）を追加:

```ts
// before
export const mcSessionLock = sqliteTable("mc_session_lock", {
	id: integer("id").primaryKey(),
	guildId: text("guild_id").notNull(),
	acquiredAt: integer("acquired_at").notNull(),
	connected: integer("connected").notNull().default(0),
	connectedAt: integer("connected_at"),
});
// after
export const mcSessionLock = sqliteTable(
	"mc_session_lock",
	{
		id: integer("id").primaryKey(),
		guildId: text("guild_id").notNull(),
		acquiredAt: integer("acquired_at").notNull(),
		connected: integer("connected").notNull().default(0),
		connectedAt: integer("connected_at"),
	},
	(table) => [check("mc_session_lock_single_row", sql`${table.id} = 1`)],
);
```

- [ ] **Step 2: ddl.ts 生成器を作成**

`packages/store/src/ddl.ts` を作成する:

```ts
import { SQLiteSyncDialect, getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "./schema.ts";

const dialect = new SQLiteSyncDialect();

/** 単一テーブル分の CREATE TABLE IF NOT EXISTS（+ 付随する CREATE INDEX）を生成する */
function generateTableDdl(table: SQLiteTable): string {
	const cfg = getTableConfig(table);
	const lines: string[] = [];

	for (const col of cfg.columns) {
		let line = `\t${col.name} ${col.getSQLType().toUpperCase()}`;
		if (col.primary && col.autoIncrement) {
			line += " PRIMARY KEY AUTOINCREMENT";
		} else if (col.primary) {
			line += " PRIMARY KEY";
		}
		if (col.notNull && !col.primary) {
			line += " NOT NULL";
		}
		if (col.default !== undefined) {
			line += ` DEFAULT ${typeof col.default === "string" ? `'${col.default}'` : String(col.default)}`;
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
```

> 注: `cfg.checks[].value` は drizzle の `SQL` オブジェクト。`dialect.sqlToQuery(...).sql` で文字列化する（プロトタイプで `"mc_session_lock"."id" = 1` を生成・動作確認済み）。`idx.config.columns` の要素は `IndexColumn`。`.name` を取り出す（型が緩いので `as { name: string }`）。

- [ ] **Step 3: db.ts を生成結果へ置換**

`packages/store/src/db.ts` の import に追加:

```ts
import { buildCreateTablesSql } from "./ddl.ts";
```

`CREATE_TABLES_SQL` の手書き定義（同期必須コメント + 巨大テンプレートリテラル、現状の 32〜88 行目）を次の 1 行に置き換える:

```ts
/**
 * テーブル作成 DDL。schema.ts（Drizzle 定義）から生成される唯一のソース。
 * migrateDb() の後に実行され、未作成テーブルのみ作成する（既存 DB では no-op）。
 */
export const CREATE_TABLES_SQL = buildCreateTablesSql();
```

`migrateDb()` と `createDb()` の本体・`hasTable` は**一切変更しない**。`CREATE_TABLES_SQL` を使う箇所（`createDb` 内の `sqlite.exec(CREATE_TABLES_SQL)`、`test-helpers.ts`）は export 名が同じなので無変更。

- [ ] **Step 4: 契約 spec が green のままか確認（リファクタの安全網）**

Run: `nr test:spec spec/store/ddl.spec.ts`
Expected: Task 1 と同じく全 pass。スキーマが変わっていない証拠。

- [ ] **Step 5: 移行安全性の一回限り検証（legacy ⇔ 生成 の等価）**

リポジトリ root で次のスクリプトを実行し、旧 SQL と新生成 DDL が同一スキーマを作ることを確認する（PR にエビデンスとして添付。コミットはしない）:

```bash
cat > packages/store/src/_equiv.tmp.ts <<'EOF'
import { Database } from "bun:sqlite";
import { buildCreateTablesSql } from "./ddl.ts";

const LEGACY = `
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
CREATE TABLE IF NOT EXISTS mood_state (
	agent_id TEXT PRIMARY KEY,
	valence REAL NOT NULL,
	arousal REAL NOT NULL,
	dominance REAL NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emotion_provider_cooldown (
	provider_id TEXT NOT NULL,
	model_id TEXT NOT NULL,
	until_ms INTEGER NOT NULL,
	reason TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS agent_heartbeat (
	agent_id TEXT PRIMARY KEY,
	last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mc_session_lock (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	guild_id TEXT NOT NULL,
	acquired_at INTEGER NOT NULL,
	connected INTEGER NOT NULL DEFAULT 0,
	connected_at INTEGER
);
`;

function dump(sqlExec: string) {
	const db = new Database(":memory:");
	db.exec(sqlExec);
	const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
	const out: Record<string, unknown> = {};
	for (const t of tables) {
		out[t] = {
			cols: db.prepare(`PRAGMA table_info(${t})`).all(),
			idx: (db.prepare(`PRAGMA index_list(${t})`).all() as { name: string }[]).map((i) => ({ ...i, cols: db.prepare(`PRAGMA index_info(${i.name})`).all() })),
		};
	}
	return JSON.stringify(out);
}

const a = dump(LEGACY);
const b = dump(buildCreateTablesSql());
console.log("PRAGMA schema identical:", a === b);
if (a !== b) {
	console.log("LEGACY:", a);
	console.log("GEN   :", b);
	process.exit(1);
}
EOF
bun run packages/store/src/_equiv.tmp.ts
rm -f packages/store/src/_equiv.tmp.ts
```

Expected: `PRAGMA schema identical: true`。false の場合は生成器を修正する（テーブルを削除して報告しない）。

- [ ] **Step 6: 全検証**

Run: `nr fmt && nr validate && nr test`
Expected: `nr validate` 0 error、`nr test` 全 pass（既存の store 系テストも green）。

- [ ] **Step 7: 手書き SQL が残っていないか確認**

Run: `rg -n "CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS" packages/store/src`
Expected: ヒットは `ddl.ts` の**生成テンプレート内の文字列リテラル**のみ。`db.ts` に手書き DDL テンプレートが残っていないこと。

- [ ] **Step 8: コミット**

```bash
git add -A
git commit -m "refactor(store): スキーマ DDL を Drizzle 定義から生成し単一ソース化する"
```

---

## 最終検証（全タスク完了後）

- [ ] **Step 1: クリーン検証**

Run: `nr fmt && nr validate && nr test`
Expected: 0 error / 全 pass。出力を PR 説明に貼る（完了宣言ルール）。

- [ ] **Step 2: PR 作成**

```bash
git push -u origin <branch>
gh pr create --title "refactor(store): スキーマ DDL を Drizzle 定義から単一ソース生成する" --body "<検証結果 + 等価チェック結果を含む説明>"
```

PR 本文に Phase 2 ロードマップ「store スキーマ単一ソース化」完了、`nr validate`/`nr test` 結果、Step 5 の `PRAGMA schema identical: true` エビデンス、`migrateDb` 不変・live DB 無影響（CREATE TABLE IF NOT EXISTS は既存 DB で no-op）を明記する。

---

## スコープ外（必要なら Issue 化）

- `migrateDb()` の手続き的マイグレーション（カラム rename/add/drop）は本 PR の対象外。将来 drizzle-kit を導入してマイグレーション履歴を持つかは別途検討（live DB への `__drizzle_migrations` ベースライン整備が必要なため高リスク）。
- DB 行の zod 検証ヘルパ `parse-helpers.ts`（Issue #1077）とは独立。
