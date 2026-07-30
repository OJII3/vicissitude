# Thread Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** スレッド単位の capability override（親チャンネル継承 + 明示 override）を導入し、スレッド主体で運用するギルドで観察・応答範囲をスレッド粒度で制御できるようにする。

**Architecture:** `channel_capabilities` は親チャンネルのデフォルトとして維持し、nullable boolean 列を持つ `thread_capability_overrides` テーブルを追加する（`NULL` = 親を継承）。ドメイン層の純関数 `resolveEffectiveCapabilities(channel, override)` が唯一の解決点で、ingest 経路（Gateway）と effect 実行経路（effect worker）の両方がこれを通る。Discord 側の設定は既存 `/vicissitude-channel` コマンドに thread subcommand を足して行う。

**Tech Stack:** TypeScript (ESM, Node 24) / postgres.js / discord.js 14 / vitest / oxlint + oxfmt

**Source spec:** [2026-07-29 Phase 2 Conversation Cognition 設計](../specs/2026-07-29-phase-2-conversation-cognition-design.md) §2（Thread Scope）。この計画は Phase 2A の先頭スライスのみを対象とし、durable batch（job の scope キー化・cursor・actor 状態）は後続の別計画で扱う。そのため migration 番号は spec §8 の論理的なまとめ方とは異なり、本スライスが `0002_thread_scope.sql`、durable batch が `0003_*` になる。

**Conventions to follow:**
- ユニットテストは実装と同じディレクトリに `*.test.ts`（`nr test:unit` = `vitest run src`）
- PostgreSQL を使う統合テストは `spec/**/*.spec.ts`（`nr test:spec`。実 DB を起動するため spec 全体が走る）
- postgres.js のテンプレートリテラル SQL。列名は snake_case、TS は camelCase で明示マッピング
- capability の変更は必ず `audit_entries` に記録し、`actor` と `reason` を必須にする

---

### Task 1: migration 0002 — thread_capability_overrides と events index

**Files:**
- Create: `migrations/0002_thread_scope.sql`
- Modify: `spec/adapters/postgres/migrations.spec.ts`（`0001` を期待している箇所）

- [ ] **Step 1: 失敗するテストを書く**

`spec/adapters/postgres/migrations.spec.ts` の最初のテストを、両 migration が適用されることを期待する形に変更する。

```ts
  it("applies each migration once and records its checksum", async () => {
    const first = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    const second = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    expect(first).toMatchObject({ appliedVersions: ["0001", "0002"] });
    expect(second).toMatchObject({ appliedVersions: [] });
    expect(first.appliedAt).toBeInstanceOf(Date);

    const status = await migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!);
    expect(status).toEqual([
      expect.objectContaining({ version: "0001", name: "durable_spine", state: "applied" }),
      expect.objectContaining({ version: "0002", name: "thread_scope", state: "applied" }),
    ]);
    expect(status[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });
```

同じファイル内で `appliedVersions` に `["0001"]` を期待している残りのテスト（"serializes concurrent migration runs..."、"returns applied versions and records an admin audit..."、"audits an explicit no-op..."）も `["0001", "0002"]` に更新する。

```ts
      expect([firstResult.appliedVersions, secondResult.appliedVersions].sort((a, b) => a.length - b.length)).toEqual([
        [],
        ["0001", "0002"],
      ]);
```

```ts
    expect(result.appliedVersions).toEqual(["0001", "0002"]);
```

```ts
    expect(first.appliedVersions).toEqual(["0001", "0002"]);
    expect(second.appliedVersions).toEqual([]);
```

さらに、新しいテーブルと index が作られたことを確認するテストを同じ `describe` の末尾に追加する。

```ts
  it("creates the thread override table and the thread-aware event index", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_name = 'thread_capability_overrides'
        and column_name in ('observe_events', 'respond_to_mentions', 'add_reactions')
      order by column_name
    `;
    expect(columns).toEqual([
      { column_name: "add_reactions", is_nullable: "YES" },
      { column_name: "observe_events", is_nullable: "YES" },
      { column_name: "respond_to_mentions", is_nullable: "YES" },
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'events' and indexname = 'events_thread_scope_time_idx'
    `;
    expect(indexes).toHaveLength(1);
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `nr test:spec`
Expected: FAIL。`appliedVersions` が `["0001"]` のままで `["0001", "0002"]` と一致せず、`thread_capability_overrides` の列が空配列で返る。

- [ ] **Step 3: migration を書く**

`migrations/0002_thread_scope.sql` を作成する。

```sql
CREATE TABLE thread_capability_overrides (
  guild_id text NOT NULL, channel_id text NOT NULL, thread_id text NOT NULL,
  observe_events boolean, respond_to_mentions boolean, add_reactions boolean,
  updated_at timestamptz NOT NULL, updated_by text NOT NULL, reason text NOT NULL,
  PRIMARY KEY (guild_id, channel_id, thread_id),
  CHECK (observe_events IS NOT NULL OR respond_to_mentions IS NOT NULL OR add_reactions IS NOT NULL)
);

CREATE INDEX events_thread_scope_time_idx ON events (guild_id, channel_id, thread_id, occurred_at DESC);
```

`CHECK` 制約は「全 capability が継承の row は存在しない」という不変条件を DB 側で保証する。repository はこの状態になったとき row を削除する（Task 3）。

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `nr test:spec`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add migrations/0002_thread_scope.sql spec/adapters/postgres/migrations.spec.ts
git commit -m "feat: add thread capability override schema"
```

---

### Task 2: 実効 capability を解決するドメイン純関数

**Files:**
- Create: `src/modules/channels/thread-capability.ts`
- Create: `src/modules/channels/thread-capability.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`src/modules/channels/thread-capability.test.ts` を作成する。

```ts
import { describe, expect, it } from "vitest";
import { denyAllCapabilities, type ChannelCapabilities } from "./channel-capability.js";
import { resolveEffectiveCapabilities, type ThreadCapabilityOverride } from "./thread-capability.js";

const channel: ChannelCapabilities = {
  ...denyAllCapabilities("guild-1", "channel-1"),
  observeEvents: true,
  respondToMentions: true,
  createThreads: true,
};

function override(patch: Partial<ThreadCapabilityOverride>): ThreadCapabilityOverride {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    threadId: "thread-1",
    observeEvents: null,
    respondToMentions: null,
    addReactions: null,
    ...patch,
  };
}

describe("resolveEffectiveCapabilities", () => {
  it("returns the channel capabilities unchanged without an override", () => {
    expect(resolveEffectiveCapabilities(channel, null)).toEqual(channel);
  });

  it("inherits the channel value for every null field", () => {
    expect(resolveEffectiveCapabilities(channel, override({}))).toEqual(channel);
  });

  it("denies a capability the parent channel allows", () => {
    expect(resolveEffectiveCapabilities(channel, override({ observeEvents: false }))).toEqual({
      ...channel,
      observeEvents: false,
    });
  });

  it("allows a capability the parent channel denies", () => {
    const quiet: ChannelCapabilities = { ...denyAllCapabilities("guild-1", "channel-1"), observeEvents: false };
    expect(resolveEffectiveCapabilities(quiet, override({ observeEvents: true, respondToMentions: true }))).toEqual({
      ...quiet,
      observeEvents: true,
      respondToMentions: true,
    });
  });

  it("leaves capabilities that are not thread-overridable untouched", () => {
    const resolved = resolveEffectiveCapabilities(channel, override({ addReactions: true }));
    expect(resolved.createThreads).toBe(true);
    expect(resolved.shareFiles).toBe(false);
    expect(resolved.addReactions).toBe(true);
  });

  it("keeps the parent channel id so capability lookups stay stable", () => {
    const resolved = resolveEffectiveCapabilities(channel, override({ observeEvents: false }));
    expect(resolved.channelId).toBe("channel-1");
    expect(resolved.guildId).toBe("guild-1");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `pnpm exec vitest run src/modules/channels/thread-capability.test.ts`
Expected: FAIL。`Failed to resolve import "./thread-capability.js"`

- [ ] **Step 3: 実装を書く**

`src/modules/channels/thread-capability.ts` を作成する。

```ts
import type { ChannelCapabilities } from "./channel-capability.js";

export const THREAD_OVERRIDABLE_CAPABILITIES = ["observeEvents", "respondToMentions", "addReactions"] as const;

export type ThreadOverridableCapability = (typeof THREAD_OVERRIDABLE_CAPABILITIES)[number];

export interface ThreadCapabilityOverride {
  guildId: string;
  channelId: string;
  threadId: string;
  observeEvents: boolean | null;
  respondToMentions: boolean | null;
  addReactions: boolean | null;
}

export function inheritAllOverride(guildId: string, channelId: string, threadId: string): ThreadCapabilityOverride {
  return { guildId, channelId, threadId, observeEvents: null, respondToMentions: null, addReactions: null };
}

export function isInheritOnly(override: ThreadCapabilityOverride): boolean {
  return THREAD_OVERRIDABLE_CAPABILITIES.every((capability) => override[capability] === null);
}

export function resolveEffectiveCapabilities(
  channel: ChannelCapabilities,
  override: ThreadCapabilityOverride | null,
): ChannelCapabilities {
  if (!override) return channel;
  const resolved = { ...channel };
  for (const capability of THREAD_OVERRIDABLE_CAPABILITIES) {
    const value = override[capability];
    if (value !== null) resolved[capability] = value;
  }
  return resolved;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `pnpm exec vitest run src/modules/channels/thread-capability.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: コミット**

```bash
git add src/modules/channels/thread-capability.ts src/modules/channels/thread-capability.test.ts
git commit -m "feat: resolve effective capabilities from thread overrides"
```

---

### Task 3: thread override の PostgreSQL repository

**Files:**
- Create: `src/adapters/postgres/thread-capability-repository.ts`
- Create: `spec/adapters/postgres/thread-capability-repository.spec.ts`

`get` は row がなければ `null` を返す（`resolveEffectiveCapabilities` の第2引数にそのまま渡せる）。`patch` は `undefined` のフィールドを変更せず、`null` を「継承へ戻す」として扱い、全フィールドが `null` になったら row を削除して `null` を返す。同一 scope の並行更新は既存 channel repository と同じ advisory lock パターンで直列化する。

- [ ] **Step 1: 失敗するテストを書く**

`spec/adapters/postgres/thread-capability-repository.spec.ts` を作成する。

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresThreadCapabilityRepository } from "../../../src/adapters/postgres/thread-capability-repository.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, thread_capability_overrides cascade`;
});

afterAll(async () => {
  await sql.end();
});

const now = new Date("2026-01-02T03:04:05.000Z");

describe("PostgresThreadCapabilityRepository", () => {
  it("returns null without writing a row for an unconfigured thread", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    await expect(repository.get("guild-1", "channel-1", "thread-1")).resolves.toBeNull();
    await expect(sql`select * from thread_capability_overrides`).resolves.toHaveLength(0);
  });

  it("stores an override and records the change audit", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: true },
      "operator-1",
      "watch this thread",
      now,
    );

    expect(result).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      observeEvents: true,
      respondToMentions: null,
      addReactions: null,
    });
    await expect(repository.get("guild-1", "channel-1", "thread-1")).resolves.toEqual(result);
    const rows = await sql<{ category: string; summary: Record<string, unknown>; created_at: Date }[]>`
      select category, summary, created_at from audit_entries
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "thread.capability.changed",
      created_at: now,
      summary: {
        actor: "operator-1",
        reason: "watch this thread",
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        before: null,
        after: { observeEvents: true, respondToMentions: null, addReactions: null },
      },
    });
  });

  it("merges a patch into an existing override and leaves untouched fields alone", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "first", now);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { respondToMentions: false },
      "operator-2",
      "second",
      now,
    );

    expect(result).toMatchObject({ observeEvents: true, respondToMentions: false, addReactions: null });
  });

  it("deletes the row when every capability returns to inherit", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "first", now);

    const result = await repository.patch(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: null },
      "operator-1",
      "back to inherit",
      now,
    );

    expect(result).toBeNull();
    await expect(sql`select * from thread_capability_overrides`).resolves.toHaveLength(0);
    const rows = await sql<{ summary: { before: unknown; after: unknown } }[]>`
      select summary from audit_entries where category = 'thread.capability.changed' order by created_at
    `;
    expect(rows.at(-1)?.summary.after).toBeNull();
  });

  it("scopes overrides to a single thread", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);
    await repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "operator-1", "one", now);

    await expect(repository.get("guild-1", "channel-1", "thread-2")).resolves.toBeNull();
    await expect(repository.get("guild-1", "channel-2", "thread-1")).resolves.toBeNull();
  });

  it("rejects invalid metadata", async () => {
    const repository = new PostgresThreadCapabilityRepository(sql);

    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, " ", "reason", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor", " ", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor", "reason", new Date("x")),
    ).rejects.toThrow();
  });

  it("merges concurrent patches for one thread scope", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresThreadCapabilityRepository(firstSql);
    const second = new PostgresThreadCapabilityRepository(secondSql);

    try {
      await Promise.all([
        first.patch("guild-1", "channel-1", "thread-1", { observeEvents: true }, "actor-1", "first", now),
        second.patch("guild-1", "channel-1", "thread-1", { addReactions: true }, "actor-2", "second", now),
      ]);

      await expect(first.get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({
        observeEvents: true,
        addReactions: true,
      });
      const audits = await sql`select id from audit_entries where category = 'thread.capability.changed'`;
      expect(audits).toHaveLength(2);
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `nr test:spec`
Expected: FAIL。`Failed to resolve import ".../thread-capability-repository.js"`

- [ ] **Step 3: 実装を書く**

`src/adapters/postgres/thread-capability-repository.ts` を作成する。

```ts
import type { Sql } from "postgres";
import { newId } from "../../shared/ids.js";
import {
  inheritAllOverride,
  isInheritOnly,
  THREAD_OVERRIDABLE_CAPABILITIES,
  type ThreadCapabilityOverride,
} from "../../modules/channels/thread-capability.js";

export type ThreadCapabilityPatch = Partial<
  Pick<ThreadCapabilityOverride, "observeEvents" | "respondToMentions" | "addReactions">
>;

const LOCK_NAMESPACE = 84623818;

function mapRow(row: Record<string, unknown>): ThreadCapabilityOverride {
  return {
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    threadId: row.thread_id as string,
    observeEvents: row.observe_events as boolean | null,
    respondToMentions: row.respond_to_mentions as boolean | null,
    addReactions: row.add_reactions as boolean | null,
  };
}

function auditValue(override: ThreadCapabilityOverride | null): Record<string, boolean | null> | null {
  if (!override) return null;
  return Object.fromEntries(THREAD_OVERRIDABLE_CAPABILITIES.map((key) => [key, override[key]]));
}

function validateMetadata(actor: string, reason: string, now: Date): void {
  if (!actor.trim() || !reason.trim()) throw new Error("actor and reason must be nonblank");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
}

export class PostgresThreadCapabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(guildId: string, channelId: string, threadId: string): Promise<ThreadCapabilityOverride | null> {
    const rows = await this.sql`
      select * from thread_capability_overrides
      where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  public async patch(
    guildId: string,
    channelId: string,
    threadId: string,
    patch: ThreadCapabilityPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ThreadCapabilityOverride | null> {
    validateMetadata(actor, reason, now);
    const trimmedActor = actor.trim();
    const trimmedReason = reason.trim();
    return this.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}:${threadId}`}, ${LOCK_NAMESPACE}))
      `;
      const rows = await transaction`
        select * from thread_capability_overrides
        where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
        for update
      `;
      const before = rows[0] ? mapRow(rows[0]) : null;
      const next: ThreadCapabilityOverride = {
        ...(before ?? inheritAllOverride(guildId, channelId, threadId)),
        ...patch,
      };
      const after = isInheritOnly(next) ? null : next;
      if (after) {
        await transaction`
          insert into thread_capability_overrides (
            guild_id, channel_id, thread_id, observe_events, respond_to_mentions, add_reactions,
            updated_at, updated_by, reason
          ) values (
            ${guildId}, ${channelId}, ${threadId}, ${after.observeEvents}, ${after.respondToMentions},
            ${after.addReactions}, ${now}, ${trimmedActor}, ${trimmedReason}
          ) on conflict (guild_id, channel_id, thread_id) do update set
            observe_events = excluded.observe_events, respond_to_mentions = excluded.respond_to_mentions,
            add_reactions = excluded.add_reactions, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by, reason = excluded.reason
        `;
      } else {
        await transaction`
          delete from thread_capability_overrides
          where guild_id = ${guildId} and channel_id = ${channelId} and thread_id = ${threadId}
        `;
      }
      await transaction`
        insert into audit_entries (id, category, summary, created_at)
        values (
          ${newId()}, 'thread.capability.changed',
          ${transaction.json({
            actor: trimmedActor,
            reason: trimmedReason,
            guildId,
            channelId,
            threadId,
            before: auditValue(before),
            after: auditValue(after),
          })},
          ${now}
        )
      `;
      return after;
    });
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `nr test:spec`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/adapters/postgres/thread-capability-repository.ts spec/adapters/postgres/thread-capability-repository.spec.ts
git commit -m "feat: persist thread capability overrides"
```

---

### Task 4: 実効 capability を返す合成 repository

**Files:**
- Create: `src/adapters/postgres/effective-capability-repository.ts`
- Create: `spec/adapters/postgres/effective-capability-repository.spec.ts`

Gateway と effect worker が使う単一の入口。`threadId` が `null` ならチャンネル capability をそのまま返す。

- [ ] **Step 1: 失敗するテストを書く**

`spec/adapters/postgres/effective-capability-repository.spec.ts` を作成する。

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities } from "../../../src/modules/channels/channel-capability.js";
import { PostgresChannelCapabilityRepository } from "../../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresThreadCapabilityRepository } from "../../../src/adapters/postgres/thread-capability-repository.js";
import { PostgresEffectiveCapabilityRepository } from "../../../src/adapters/postgres/effective-capability-repository.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, thread_capability_overrides, channel_capabilities cascade`;
});

afterAll(async () => {
  await sql.end();
});

const now = new Date("2026-01-02T03:04:05.000Z");

function build(): PostgresEffectiveCapabilityRepository {
  return new PostgresEffectiveCapabilityRepository(
    new PostgresChannelCapabilityRepository(sql),
    new PostgresThreadCapabilityRepository(sql),
  );
}

describe("PostgresEffectiveCapabilityRepository", () => {
  it("returns channel capabilities for a non-thread message", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);

    await expect(build().get("guild-1", "channel-1", null)).resolves.toMatchObject({ observeEvents: true });
  });

  it("inherits channel capabilities in a thread without an override", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);

    await expect(build().get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({ observeEvents: true });
  });

  it("applies a deny override inside an allowed channel", async () => {
    const channels = new PostgresChannelCapabilityRepository(sql);
    const threads = new PostgresThreadCapabilityRepository(sql);
    await channels.patch("guild-1", "channel-1", { observeEvents: true }, "operator", "enable", now);
    await threads.patch("guild-1", "channel-1", "thread-1", { observeEvents: false }, "operator", "quiet", now);

    await expect(build().get("guild-1", "channel-1", "thread-1")).resolves.toMatchObject({ observeEvents: false });
    await expect(build().get("guild-1", "channel-1", null)).resolves.toMatchObject({ observeEvents: true });
  });

  it("applies an allow override inside a denied channel", async () => {
    const threads = new PostgresThreadCapabilityRepository(sql);
    await threads.patch(
      "guild-1",
      "forum-1",
      "thread-1",
      { observeEvents: true, respondToMentions: true },
      "operator",
      "watch one thread",
      now,
    );

    await expect(build().get("guild-1", "forum-1", "thread-1")).resolves.toMatchObject({
      observeEvents: true,
      respondToMentions: true,
    });
    await expect(build().get("guild-1", "forum-1", null)).resolves.toEqual(denyAllCapabilities("guild-1", "forum-1"));
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `nr test:spec`
Expected: FAIL。`Failed to resolve import ".../effective-capability-repository.js"`

- [ ] **Step 3: 実装を書く**

`src/adapters/postgres/effective-capability-repository.ts` を作成する。

```ts
import type { ChannelCapabilities } from "../../modules/channels/channel-capability.js";
import { resolveEffectiveCapabilities } from "../../modules/channels/thread-capability.js";
import type { PostgresChannelCapabilityRepository } from "./channel-capability-repository.js";
import type { PostgresThreadCapabilityRepository } from "./thread-capability-repository.js";

export class PostgresEffectiveCapabilityRepository {
  public constructor(
    private readonly channels: PostgresChannelCapabilityRepository,
    private readonly threads: PostgresThreadCapabilityRepository,
  ) {}

  public async get(guildId: string, channelId: string, threadId: string | null): Promise<ChannelCapabilities> {
    const channel = await this.channels.get(guildId, channelId);
    if (!threadId) return channel;
    const override = await this.threads.get(guildId, channelId, threadId);
    return resolveEffectiveCapabilities(channel, override);
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `nr test:spec`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/adapters/postgres/effective-capability-repository.ts spec/adapters/postgres/effective-capability-repository.spec.ts
git commit -m "feat: compose channel and thread capabilities"
```

---

### Task 5: Gateway の ingest を実効 capability で判定する

**Files:**
- Modify: `src/apps/discord-gateway.ts:95`（repository の構築）と `:120`（capability 取得）
- Modify: `spec/apps/discord-gateway.spec.ts`（スレッド経路の確認を追加）

Gateway は現在 `capabilities.get(config.guildId, input.channelId)` を呼んでいる。ここに `input.threadId` を渡す。`ingestDiscordMessage` 側は解決済みの `ChannelCapabilities` を受け取る契約のままで変更不要（`channelId` は親チャンネルのまま維持されるため既存の scope チェックも通る）。

- [ ] **Step 1: 失敗するテストを書く**

`spec/apps/discord-gateway.spec.ts` に 2 つのテストを追加する。このファイルには既に `threadMessage(parentChannelId)` helper と、`handlers.messageCreate` を直接呼ぶパターンがあるのでそれを再利用する。ファイル冒頭に import を追加する。

```ts
import { PostgresChannelCapabilityRepository } from "../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresThreadCapabilityRepository } from "../../src/adapters/postgres/thread-capability-repository.js";
```

`describe("runGateway", ...)` の末尾に次を追加する。このファイルには `beforeEach` の truncate がないため、各テストが `finally` で自分の書き込みを消す。

```ts
  async function runGatewayOnce(message: unknown, logger: { error: () => void; debug: ReturnType<typeof vi.fn> }) {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const inflight = createInFlightTracker();
    const accepting = { value: false };
    let release!: (signal: AbortSignal) => void;
    const shutdown = new Promise<AbortSignal>((resolve) => {
      release = resolve;
    });
    const run = runGateway({
      sql,
      client: {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers[event] = handler;
        }),
        user: { id: "bot" },
      } as never,
      config: { migrationsDir: "migrations", guildId: "guild", adminIds: ["admin"], discordToken: "token" } as never,
      health: { setReady: vi.fn() } as never,
      logger: logger as never,
      shutdown,
      prepared: true,
      startClient: async () => undefined,
      registerCommands: async () => undefined,
      accepting,
      inflight,
    });
    await vi.waitFor(() => expect(handlers.messageCreate).toBeTypeOf("function"));
    handlers.messageCreate!(message);
    await inflight.drain();
    release(new AbortController().signal);
    await run;
  }

  const cleanup = () =>
    sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events, thread_capability_overrides, channel_capabilities cascade`;

  it("ingests a thread message that a thread override allows in a denied channel", async () => {
    const now = new Date();
    await new PostgresChannelCapabilityRepository(sql).patch(
      "guild",
      "forum-1",
      { respondToMentions: false },
      "admin",
      "closed forum",
      now,
    );
    await new PostgresThreadCapabilityRepository(sql).patch(
      "guild",
      "forum-1",
      "thread-1",
      { respondToMentions: true },
      "admin",
      "watch one thread",
      now,
    );
    const logger = { error: vi.fn(), debug: vi.fn() };

    try {
      await runGatewayOnce(threadMessage("forum-1"), logger);

      await expect(sql`select channel_id, thread_id from events`).resolves.toEqual([
        { channel_id: "forum-1", thread_id: "thread-1" },
      ]);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "forum-1", threadId: "thread-1", jobQueued: true }),
        "Discord message ingested",
      );
    } finally {
      await cleanup();
    }
  });

  it("ignores a thread message that a thread override denies in an allowed channel", async () => {
    const now = new Date();
    await new PostgresChannelCapabilityRepository(sql).patch(
      "guild",
      "channel-1",
      { observeEvents: true, respondToMentions: true },
      "admin",
      "open channel",
      now,
    );
    await new PostgresThreadCapabilityRepository(sql).patch(
      "guild",
      "channel-1",
      "thread-1",
      { observeEvents: false, respondToMentions: false },
      "admin",
      "quiet thread",
      now,
    );
    const logger = { error: vi.fn(), debug: vi.fn() };

    try {
      await runGatewayOnce(threadMessage("channel-1"), logger);

      await expect(sql`select id from events`).resolves.toHaveLength(0);
      await expect(sql`select id from jobs`).resolves.toHaveLength(0);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "channel-1", threadId: "thread-1", reason: "channel_not_allowed" }),
        "Discord message ignored",
      );
    } finally {
      await cleanup();
    }
  });
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `nr test:spec`
Expected: FAIL。1 つ目は thread override が無視されて event が作られず（`[]` が返る）、2 つ目は逆に event が 1 件作られる。

- [ ] **Step 3: Gateway を変更する**

`src/apps/discord-gateway.ts` の repository 構築（95 行目付近）を差し替える。

```ts
  const channelCapabilities = new PostgresChannelCapabilityRepository(sql);
  const threadCapabilities = new PostgresThreadCapabilityRepository(sql);
  const capabilities = new PostgresEffectiveCapabilityRepository(channelCapabilities, threadCapabilities);
```

capability 取得（120 行目付近）にスレッドを渡す。

```ts
      const capability = await capabilities.get(config.guildId, input.channelId, input.threadId);
```

import を追加する。

```ts
import { PostgresThreadCapabilityRepository } from "../adapters/postgres/thread-capability-repository.js";
import { PostgresEffectiveCapabilityRepository } from "../adapters/postgres/effective-capability-repository.js";
```

`handleChannelCommand` に渡している `commandRepository` は `channelCapabilities` を参照するよう変更する（150-155 行目付近）。

```ts
    const commandRepository = {
      get: channelCapabilities.get.bind(channelCapabilities),
      patch: async (...args: Parameters<typeof channelCapabilities.patch>) => {
        await channelCapabilities.patch(...args);
      },
    };
```

`runEffectLoop` の呼び出し（168 行目付近）は、このタスクでは `channelCapabilities` を渡すよう変更しておく。effect 実行経路をスレッド対応にするのは Task 7 で、そこで `capabilities` に切り替える。こうすることでこのタスク単体でも型が通る。

```ts
  const effectLoop = runEffectLoop(effects, channelCapabilities, executor, controller.signal, logger, rejectFatal);
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `nr test:spec`
Expected: PASS

- [ ] **Step 5: 型と lint を確認する**

Run: `nr check && nr lint`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/apps/discord-gateway.ts spec/e2e/mention-response.spec.ts
git commit -m "feat: apply thread overrides when ingesting messages"
```

---

### Task 6: `/vicissitude-channel` に thread subcommand を追加する

**Files:**
- Modify: `src/adapters/discord/channel-command.ts`
- Modify: `src/adapters/discord/channel-command.test.ts`（存在しない場合は Create）

`thread-show` と `thread-set` を追加する。`thread-set` の各 capability は `allow` / `deny` / `inherit` の三値文字列オプションで受け取る。

- [ ] **Step 1: 失敗するテストを書く**

`src/adapters/discord/channel-command.test.ts` に次を追加する（ファイルがなければ作成し、既存の `handleChannelCommand` テストがある場合はその interaction モックの作り方を踏襲する）。

```ts
import { describe, expect, it, vi } from "vitest";
import { handleChannelCommand } from "./channel-command.js";

function interactionFor(subcommand: string, options: Record<string, string | boolean | null>, channel: unknown) {
  return {
    guildId: "guild-1",
    user: { id: "admin-1" },
    options: {
      getSubcommand: () => subcommand,
      getChannel: () => channel,
      getString: (name: string, required?: boolean) => {
        const value = options[name];
        if (typeof value === "string") return value;
        if (required) throw new Error(`missing ${name}`);
        return null;
      },
      getBoolean: (name: string) => {
        const value = options[name];
        return typeof value === "boolean" ? value : null;
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const thread = { id: "thread-1", parentId: "channel-1", isThread: () => true };
const clock = { now: () => new Date("2026-01-02T03:04:05.000Z") };

describe("handleChannelCommand thread subcommands", () => {
  it("translates allow, deny and inherit into an override patch", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn().mockResolvedValue(undefined),
      getThread: vi.fn().mockResolvedValue(null),
      patchThread: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = interactionFor(
      "thread-set",
      { observe: "allow", mentions: "deny", reactions: "inherit", reason: "tune thread" },
      thread,
    );

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.patchThread).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: true, respondToMentions: false, addReactions: null },
      "admin-1",
      "tune thread",
      clock.now(),
    );
  });

  it("omits capabilities that were not supplied", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn().mockResolvedValue(null),
      patchThread: vi.fn().mockResolvedValue(undefined),
    };
    const interaction = interactionFor("thread-set", { observe: "deny", reason: "quiet" }, thread);

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.patchThread).toHaveBeenCalledWith(
      "guild-1",
      "channel-1",
      "thread-1",
      { observeEvents: false },
      "admin-1",
      "quiet",
      clock.now(),
    );
  });

  it("rejects a thread subcommand on a non-thread channel", async () => {
    const repository = { get: vi.fn(), patch: vi.fn(), getThread: vi.fn(), patchThread: vi.fn() };
    const channel = { id: "channel-1", parentId: null, isThread: () => false };
    const interaction = interactionFor("thread-set", { observe: "allow", reason: "nope" }, channel);

    await expect(
      handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock),
    ).rejects.toThrow("Thread subcommands require a thread channel");
    expect(repository.patchThread).not.toHaveBeenCalled();
  });

  it("shows the current override for a thread", async () => {
    const repository = {
      get: vi.fn(),
      patch: vi.fn(),
      getThread: vi.fn().mockResolvedValue({
        guildId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
        observeEvents: true,
        respondToMentions: null,
        addReactions: null,
      }),
      patchThread: vi.fn(),
    };
    const interaction = interactionFor("thread-show", {}, thread);

    await handleChannelCommand(interaction, "guild-1", new Set(["admin-1"]), repository, clock);

    expect(repository.getThread).toHaveBeenCalledWith("guild-1", "channel-1", "thread-1");
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("observeEvents") }),
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `pnpm exec vitest run src/adapters/discord/channel-command.test.ts`
Expected: FAIL。`Unsupported subcommand: thread-set`

- [ ] **Step 3: コマンド定義とハンドラを実装する**

`src/adapters/discord/channel-command.ts` の `channelCommand` に subcommand を追加する（既存の `.addSubcommand((sub) => sub.setName("set")...)` の後ろに続ける）。

```ts
  .addSubcommand((sub) =>
    sub.setName("thread-show").setDescription("スレッドの権限overrideを表示します").addChannelOption(threadOption),
  )
  .addSubcommand((sub) =>
    sub
      .setName("thread-set")
      .setDescription("スレッド単位の権限overrideを設定します")
      .addChannelOption(threadOption)
      .addStringOption((o) =>
        o.setName("reason").setDescription("変更理由").setMinLength(1).setMaxLength(500).setRequired(true),
      )
      .addStringOption((o) => o.setName("observe").setDescription("イベントを観察する").addChoices(...overrideChoices))
      .addStringOption((o) => o.setName("mentions").setDescription("mentionへ応答する").addChoices(...overrideChoices))
      .addStringOption((o) =>
        o.setName("reactions").setDescription("reactionを追加する").addChoices(...overrideChoices),
      ),
  );
```

同ファイルの上部、`channelOption` の定義の隣に次を追加する。

```ts
const threadTypes = [
  ChannelType.GuildPublicThread,
  ChannelType.GuildPrivateThread,
  ChannelType.GuildNewsThread,
] as const;
const threadOption = (option: SlashCommandChannelOption) =>
  option
    .setName("channel")
    .setDescription("対象スレッド")
    .addChannelTypes(...threadTypes)
    .setRequired(true);
const overrideChoices = [
  { name: "allow", value: "allow" },
  { name: "deny", value: "deny" },
  { name: "inherit", value: "inherit" },
] as const;
```

`src/apps/discord-gateway.ts` の `commandRepository` に thread 用のメソッドを追加する（Task 5 で `channelCapabilities` / `threadCapabilities` を用意済み）。

```ts
    const commandRepository = {
      get: channelCapabilities.get.bind(channelCapabilities),
      patch: async (...args: Parameters<typeof channelCapabilities.patch>) => {
        await channelCapabilities.patch(...args);
      },
      getThread: threadCapabilities.get.bind(threadCapabilities),
      patchThread: async (...args: Parameters<typeof threadCapabilities.patch>) => {
        await threadCapabilities.patch(...args);
      },
    };
```

`src/adapters/discord/channel-command.ts` の `Repository` interface を拡張する。

```ts
interface Repository {
  get(guildId: string, channelId: string): Promise<ChannelCapabilities>;
  patch(
    guildId: string,
    channelId: string,
    patch: ChannelCapabilitiesPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<void>;
  getThread(guildId: string, channelId: string, threadId: string): Promise<ThreadCapabilityOverride | null>;
  patchThread(
    guildId: string,
    channelId: string,
    threadId: string,
    patch: ThreadCapabilityPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<void>;
}
```

import を追加する。

```ts
import type { ThreadCapabilityOverride } from "../../modules/channels/thread-capability.js";
import type { ThreadCapabilityPatch } from "../postgres/thread-capability-repository.js";
```

三値文字列をドメイン値に変換する helper をファイル内に置く。

```ts
function overrideValue(raw: string | null): boolean | null | undefined {
  if (raw === null) return undefined;
  if (raw === "allow") return true;
  if (raw === "deny") return false;
  if (raw === "inherit") return null;
  throw new Error(`Unsupported override value: ${raw}`);
}
```

`handleChannelCommand` の `try` ブロック内、`const subcommand = interaction.options.getSubcommand();` の直後に thread 分岐を追加する。

```ts
    if (subcommand === "thread-show" || subcommand === "thread-set") {
      if (!channel.isThread() || !channel.parentId) throw new Error("Thread subcommands require a thread channel");
      const parentId = channel.parentId;
      if (subcommand === "thread-show") {
        const override = await repository.getThread(interaction.guildId, parentId, channel.id);
        const shown = override ?? { guildId: interaction.guildId, channelId: parentId, threadId: channel.id,
          observeEvents: null, respondToMentions: null, addReactions: null };
        await interaction.editReply({ content: `\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\`` });
        return;
      }
      const patch: ThreadCapabilityPatch = {};
      const options: Array<[string, keyof ThreadCapabilityPatch]> = [
        ["observe", "observeEvents"],
        ["mentions", "respondToMentions"],
        ["reactions", "addReactions"],
      ];
      for (const [option, property] of options) {
        const value = overrideValue(interaction.options.getString(option));
        if (value !== undefined) patch[property] = value;
      }
      const reason = interaction.options.getString("reason", true).trim();
      if (!reason) throw new Error("Reason is required");
      await repository.patchThread(interaction.guildId, parentId, channel.id, patch, interaction.user.id, reason, clock.now());
      await interaction.editReply({ content: "スレッド権限を更新しました。" });
      return;
    }
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `pnpm exec vitest run src/adapters/discord/channel-command.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add src/adapters/discord/channel-command.ts src/adapters/discord/channel-command.test.ts src/apps/discord-gateway.ts
git commit -m "feat: manage thread capability overrides from Discord"
```

---

### Task 7: Effect 実行時の再認可でスレッド override を見る

**Files:**
- Modify: `src/modules/effects/run-effect-worker.ts`
- Modify: `src/modules/effects/run-effect-worker.test.ts`
- Modify: `src/apps/discord-gateway.ts`（effect worker への repository 受け渡し）

`ClaimedReplyEffect` は `capabilityChannelId`（親チャンネル）と `targetChannelId` を持つ。両者が異なるとき `targetChannelId` はスレッドなので、その thread override を含めて再評価する。

- [ ] **Step 1: 失敗するテストを書く**

`src/modules/effects/run-effect-worker.test.ts` を次の内容に置き換える。

```ts
import { describe, expect, it, vi } from "vitest";
import { runOneEffect } from "./run-effect-worker.js";

const effect = {
  id: "e1",
  runId: "r1",
  guildId: "g1",
  capabilityChannelId: "c1",
  targetChannelId: "c1",
  targetMessageId: "m1",
  content: "hello",
  attempts: 1,
};
const threadEffect = { ...effect, targetChannelId: "t1" };
const clock = { now: () => new Date("2026-01-01T00:00:00Z") };

describe("runOneEffect", () => {
  it("rechecks capability and executes an allowed effect", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn() };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: true }),
    };
    const executor = { execute: vi.fn().mockResolvedValue(undefined) };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", null);
    expect(executor.execute).toHaveBeenCalledWith(effect, clock);
  });

  it("fails revoked capability without executing", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn().mockResolvedValue(undefined) };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: false }),
    };
    const executor = { execute: vi.fn() };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(queue.fail).toHaveBeenCalledWith("e1", "capability_revoked", clock.now());
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("resolves capability for the thread when the target is a thread", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(threadEffect), fail: vi.fn() };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: true }),
    };
    const executor = { execute: vi.fn().mockResolvedValue(undefined) };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", "t1");
    expect(executor.execute).toHaveBeenCalledWith(threadEffect, clock);
  });

  it("fails an effect whose thread override revoked mention responses", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(threadEffect), fail: vi.fn().mockResolvedValue(undefined) };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: false }),
    };
    const executor = { execute: vi.fn() };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", "t1");
    expect(queue.fail).toHaveBeenCalledWith("e1", "capability_revoked", clock.now());
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `pnpm exec vitest run src/modules/effects/run-effect-worker.test.ts`
Expected: FAIL。`capabilities.get` が 2 引数でしか呼ばれておらず `toHaveBeenCalledWith("g1", "c1", null)` が一致しない。

- [ ] **Step 3: 実装を変更する**

`src/modules/effects/run-effect-worker.ts` の `CapabilityRepository` と `runOneEffect` を更新する。

```ts
interface CapabilityRepository {
  get(guildId: string, channelId: string, threadId: string | null): Promise<ChannelCapabilities>;
}
```

```ts
export async function runOneEffect(
  queue: Queue,
  capabilities: CapabilityRepository,
  executor: Executor,
  workerId: string,
  clock: Clock,
): Promise<boolean> {
  const effect = await queue.claim(workerId, clock.now());
  if (!effect) return false;
  const threadId = effect.targetChannelId === effect.capabilityChannelId ? null : effect.targetChannelId;
  const capability = await capabilities.get(effect.guildId, effect.capabilityChannelId, threadId);
  if (!capability.respondToMentions) {
    await queue.fail(effect.id, "capability_revoked", clock.now());
    return true;
  }
  await executor.execute(effect, clock);
  return true;
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `pnpm exec vitest run src/modules/effects/run-effect-worker.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Gateway の effect loop を実効 capability に切り替える**

`src/apps/discord-gateway.ts` の `runEffectLoop` の型注釈（182 行目付近）を差し替える。

```ts
async function runEffectLoop(
  queue: PostgresEffectQueue,
  capabilities: PostgresEffectiveCapabilityRepository,
  executor: DiscordEffectExecutor,
  signal: AbortSignal,
  logger: ReturnType<typeof createLogger>,
  fatal: (error: unknown) => void,
): Promise<void> {
```

Task 5 で `channelCapabilities` を渡すようにした呼び出し（168 行目付近）を、実効 capability repository に戻す。

```ts
  const effectLoop = runEffectLoop(effects, capabilities, executor, controller.signal, logger, rejectFatal);
```

Run: `nr check`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/modules/effects/run-effect-worker.ts src/modules/effects/run-effect-worker.test.ts src/apps/discord-gateway.ts
git commit -m "feat: recheck thread overrides before executing effects"
```

---

### Task 8: 全体検証とドキュメント更新

**Files:**
- Modify: `docs/` 配下の運用ドキュメントのうち `/vicissitude-channel` の使い方を説明しているもの

- [ ] **Step 1: `/vicissitude-channel` を説明しているドキュメントを探す**

Run: `grep -rn "vicissitude-channel" docs/ README.md`
Expected: 該当ファイルの一覧。ヒットがなければこの Step をスキップして Step 3 へ進む。

- [ ] **Step 2: thread subcommand を追記する**

見つかったドキュメントの `/vicissitude-channel set` を説明している箇所の直後に、次の内容を既存の文体に合わせて追記する。

```markdown
スレッド単位で権限を上書きする場合は `/vicissitude-channel thread-set` を使う。`observe` / `mentions` / `reactions` はそれぞれ `allow`（明示的に許可）、`deny`（明示的に拒否）、`inherit`（親チャンネルの設定を継承）から選ぶ。省略した項目は変更されない。現在の上書き内容は `/vicissitude-channel thread-show` で確認できる。

スレッドは既定で親チャンネルの権限を継承する。フォーラムのように特定スレッドだけを対象にしたい場合は、親チャンネルを `observe: false` にしたうえで、対象スレッドに `thread-set observe:allow` を設定する。
```

- [ ] **Step 3: 全検証を実行する**

Run: `nr validate`
Expected: format / lint / typecheck / unit / spec すべて PASS

- [ ] **Step 4: コミット**

```bash
git add docs README.md
git commit -m "docs: describe thread capability overrides"
```

- [ ] **Step 5: push して PR を作る**

```bash
git push -u origin HEAD
gh pr create --fill
```

---

## この計画の範囲外

次のスライス（別計画）で扱う。

- `conversation_evaluate` job への置き換えと scope キー化（spec §3.1）
- short batch と typing 延長（spec §3.2）
- `conversation_cursors` と `run_input_events`（spec §3.3）
- `actor_states`（spec §3.4）
- Scenario corpus（spec §6）
