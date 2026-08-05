# conversation_evaluate Job（Phase 2A: Durable Conversation Assembly）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 の `mention_response` job（イベント1件 = job 1件、即時実行）を、会話 scope 単位で short batch する `conversation_evaluate` job に置き換える（設計 §3.1〜3.4 + §3.5、migration 0003）。

**Architecture:** ingest 時に scope（guild, channel, thread|null）ごとの queued job を upsert し、後続イベント・typing で `available_at = min(now + batchWindow, first_triggered_at + maxWait)` に延長する（待機はすべて DB 永続、インメモリタイマーなし）。worker は claim 後に `conversation_cursors` 以降のイベントを batch で読み、`run_input_events` に記録し、成功時のみ cursor を前進させる。認知は Phase 1 と同じ（trigger mention への 600 文字以内 reply）で、入力だけが batch になる。`actor_states` は記録のみ（2B の宛先推定入力）。

**Tech Stack:** TypeScript (ESM) / postgres.js / zod / vitest / discord.js / nix (staging-db-rehearsal)

**確定済みの裁定（2026-08-04 ユーザー承認）:**
- **typing 延長は設計 §3.2 の「同じ式」**: `min(now + batchWindow, first_triggered_at + maxWait)`。独立パラメータ `typingExtension` は**廃止**（設定は `batchWindow` / `maxWait` の2つのみ）。corpus scenario 05 は初期値 8s/30s でこの解釈のまま成立する。
- 初期値: `batchWindow = 8000ms`, `maxWait = 30000ms`（設計 §3.5 の仮置き値。Task 2 の corpus 再生 spec がラベルとの整合を機械検証する）。
- migration 番号は **0003**（設計 §8 は「migration 0002」と書いているが、0002 は Thread Scope で消費済み）。
- reply の対象は job の trigger メッセージ（`trigger_event_id`）。後続 mention は既存 queued job を延長するだけで trigger は変わらない。
- `model-routes.json` のキー `mentionResponse` / `mentionResponseDeadlineMs` は**変更しない**（「mention への応答に使うモデル列」という意味のままで正しい）。`model_calls.purpose` は `conversation_evaluate` に変更する。

**既知の許容制限（コードコメント不要、レビュー時の参考）:** cursor は `(occurred_at, id)` タプルで前進する。同一 scope へ並行 ingest した2イベントの commit 順が occurred_at 順と逆転し、その隙間で worker が読み出すと古い方を恒久スキップする理論上の race があるが、発生窓は ms 単位・影響は「文脈1件欠落」で自己回復するため 2A では許容する（設計 §3.3 の cursor 方式に従う）。

---

## ファイル構成

**Create:**
- `migrations/0003_conversation_evaluate.sql` — jobs scope キー化 + 新3テーブル
- `src/modules/conversations/scope.ts` — `ConversationScope`
- `src/modules/conversations/batch-schedule.ts` / `batch-schedule.test.ts` — 延長式の純関数と初期値
- `src/modules/conversations/evaluate-conversation.ts` / `evaluate-conversation.test.ts` — worker 側ドメイン（`src/modules/mentions/` の置き換え）
- `spec/corpus/batch-timing.spec.ts` — corpus ラベルと batch パラメータの整合検証
- `spec/e2e/conversation-evaluate.spec.ts` — e2e（`mention-response.spec.ts` の置き換え）

**Delete:**
- `src/modules/mentions/`（`process-mention.ts`, `process-mention.test.ts`）
- `spec/e2e/mention-response.spec.ts`

**Modify:**
- `src/modules/events/ingest-message.ts`, `src/modules/jobs/job-queue.ts`
- `src/adapters/postgres/ingestion-store.ts`, `job-queue.ts`, `decision-effect-store.ts`, `effect-queue.ts`
- `src/adapters/discord/message-snapshot.ts`（typing scope 変換）
- `src/apps/discord-gateway.ts`, `src/apps/cognition-worker.ts`
- `src/config/runtime-config.ts` / `runtime-config.test.ts`
- `spec/modules/events/ingest-message.spec.ts`, `spec/adapters/postgres/`（ingestion-store / job-queue / decision-effect-store / effect-queue / migrations）, `spec/apps/discord-gateway.spec.ts`
- `src/apps/app-lifecycle.test.ts`, `src/modules/jobs/run-worker.test.ts`, `src/observability/logger.test.ts`（ClaimedJob fixture の形）
- `nix/sql/catalog-assertions.sql`, `runtime-acl.sql`, `privilege-matrix.sql`, `fixture.sql`, `nix/db-rehearsal.sh`
- `docs/superpowers/specs/2026-07-29-phase-2-conversation-cognition-design.md`, `spec/corpus/conversations/05-typing-extension.json`, `spec/corpus/README.md`

**検証コマンド（`nr` を使うこと）:** `nr check`（型）、`nr test:unit`（src 内 *.test.ts）、`nr test:spec`（spec/ 全部、一時 PostgreSQL 起動込み。ファイル単位実行は不可）、`nr validate`（全部）。

---

### Task 0: 作業ブランチ

- [ ] **Step 1: main から分岐**

```bash
git checkout -b feat/conversation-evaluate-job
```

---

### Task 1: batch 延長式の純関数

**Files:**
- Create: `src/modules/conversations/scope.ts`
- Create: `src/modules/conversations/batch-schedule.ts`
- Test: `src/modules/conversations/batch-schedule.test.ts`

- [ ] **Step 1: failing test を書く**

`src/modules/conversations/batch-schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_CONFIG, extendedAvailableAt } from "./batch-schedule.js";

const first = new Date("2026-08-04T00:00:00.000Z");
const config = { batchWindowMs: 8_000, maxWaitMs: 30_000 };

describe("extendedAvailableAt", () => {
  it("waits batchWindow from the latest event while under the cap", () => {
    expect(extendedAvailableAt(first, first, config)).toEqual(new Date("2026-08-04T00:00:08.000Z"));
    const later = new Date("2026-08-04T00:00:10.000Z");
    expect(extendedAvailableAt(later, first, config)).toEqual(new Date("2026-08-04T00:00:18.000Z"));
  });

  it("caps the wait at firstTriggeredAt + maxWait", () => {
    const nearCap = new Date("2026-08-04T00:00:25.000Z");
    expect(extendedAvailableAt(nearCap, first, config)).toEqual(new Date("2026-08-04T00:00:30.000Z"));
  });

  it("exposes the provisional defaults from design §3.5", () => {
    expect(DEFAULT_BATCH_CONFIG).toEqual({ batchWindowMs: 8_000, maxWaitMs: 30_000 });
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `nr test:unit`
Expected: FAIL（`batch-schedule.js` が存在しない）

- [ ] **Step 3: 実装**

`src/modules/conversations/scope.ts`:

```ts
export interface ConversationScope {
  guildId: string;
  channelId: string;
  threadId: string | null;
}
```

`src/modules/conversations/batch-schedule.ts`:

```ts
export interface BatchConfig {
  batchWindowMs: number;
  maxWaitMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = { batchWindowMs: 8_000, maxWaitMs: 30_000 };

/** 設計 §3.2 裁定 (2026-08-04): 後続イベントも typing も同じ式で延長する。 */
export function extendedAvailableAt(now: Date, firstTriggeredAt: Date, config: BatchConfig): Date {
  return new Date(Math.min(now.getTime() + config.batchWindowMs, firstTriggeredAt.getTime() + config.maxWaitMs));
}
```

- [ ] **Step 4: green 確認 → commit**

Run: `nr test:unit` → PASS

```bash
git add src/modules/conversations && git commit -m "feat: add conversation batch schedule formula"
```

---

### Task 2: corpus 再生でパラメータ初期値を検証する spec

**Files:**
- Test: `spec/corpus/batch-timing.spec.ts`

corpus のイベント列を延長式で再生し、「reply シナリオで参照必須メッセージが全部 batch に入り、発火が `maxWaitMs` ラベル以内」を検証する。これが設計 §3.5 の「確定は corpus のラベルに基づく」の実体。2A のトリガーは明示 mention のみなので、`mentionsBot` メッセージを含むシナリオだけが対象（01/04/05/06/08 系。03 の名前呼びは 2B）。

- [ ] **Step 1: spec を書く**

`spec/corpus/batch-timing.spec.ts`:

```ts
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_CONFIG, extendedAvailableAt } from "../../src/modules/conversations/batch-schedule.js";
import { loadScenarios, type ConversationScenario } from "./scenario.js";

const conversationsDir = resolve(import.meta.dirname, "conversations");
const base = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(base + ms);

type ScenarioEvent = ConversationScenario["events"][number];
const scopeKey = (event: ScenarioEvent) => `${event.channelId}|${event.threadId ?? ""}`;

/** 最初の mention が作る job の発火時刻と scope を、ingest/typing の延長式で再生する。 */
function simulateFirstJob(events: ScenarioEvent[]) {
  let job: { scope: string; triggerAtMs: number; availableAtMs: number } | null = null;
  for (const event of events) {
    if (job && event.atMs >= job.availableAtMs) break;
    if (!job) {
      if (event.kind === "message" && event.mentionsBot) {
        job = {
          scope: scopeKey(event),
          triggerAtMs: event.atMs,
          availableAtMs: extendedAvailableAt(at(event.atMs), at(event.atMs), DEFAULT_BATCH_CONFIG).getTime() - base,
        };
      }
      continue;
    }
    if (scopeKey(event) !== job.scope) continue;
    job.availableAtMs = extendedAvailableAt(at(event.atMs), at(job.triggerAtMs), DEFAULT_BATCH_CONFIG).getTime() - base;
  }
  return job;
}

describe("batch parameters against the scenario corpus", () => {
  const scenarios = loadScenarios(conversationsDir, { characterName: "テスト" }).filter(
    ({ scenario }) =>
      scenario.label.expectedAction === "reply" &&
      scenario.events.some((event) => event.kind === "message" && event.mentionsBot),
  );

  it("covers at least the explicit-mention scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
  });

  it.each(scenarios.map(({ file, scenario }) => [file, scenario] as const))(
    "%s: fires within maxWaitMs after batching every referenced message",
    (_file, scenario) => {
      const job = simulateFirstJob(scenario.events);
      expect(job).not.toBeNull();
      const batched = new Set(
        scenario.events
          .filter(
            (event) =>
              event.kind === "message" && scopeKey(event) === job!.scope && event.atMs <= job!.availableAtMs,
          )
          .map((event) => (event.kind === "message" ? event.id : "")),
      );
      for (const id of scenario.label.referencedMessageIds) expect(batched).toContain(id);
      expect(job!.availableAtMs - job!.triggerAtMs).toBeLessThanOrEqual(scenario.label.maxWaitMs!);
    },
  );
});
```

- [ ] **Step 2: 実行して確認**

Run: `nr test:spec`
Expected: `batch-timing.spec.ts` が PASS（初期値 8s/30s が corpus と整合していることの証明）。他 spec は既存のまま PASS。

- [ ] **Step 3: Commit**

```bash
git add spec/corpus/batch-timing.spec.ts && git commit -m "test: validate batch window defaults against scenario corpus"
```

---

### Task 3: 切替本体（migration 0003 + ingest / worker 経路の再配線）

schema・ドメイン interface・adapter が相互依存するため、このタスクだけは中間状態で suite が赤になる。サブフェーズごとに WIP commit してよいが、**タスク末尾の Step で `nr validate` が green になるまでタスク完了としない**。

#### 3a. migration 0003

**Files:**
- Create: `migrations/0003_conversation_evaluate.sql`
- Modify: `spec/adapters/postgres/migrations.spec.ts`

- [ ] **Step 1: migration を書く**

`migrations/0003_conversation_evaluate.sql`:

```sql
ALTER TABLE jobs
  ADD COLUMN guild_id text,
  ADD COLUMN channel_id text,
  ADD COLUMN thread_id text,
  ADD COLUMN first_triggered_at timestamptz,
  ADD COLUMN trigger_event_id uuid REFERENCES events(id);

UPDATE jobs SET
  guild_id = events.guild_id, channel_id = events.channel_id, thread_id = events.thread_id,
  first_triggered_at = jobs.created_at, trigger_event_id = jobs.event_id, kind = 'conversation_evaluate'
FROM events WHERE events.id = jobs.event_id;

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('conversation_evaluate'));
ALTER TABLE jobs
  ALTER COLUMN guild_id SET NOT NULL,
  ALTER COLUMN channel_id SET NOT NULL,
  ALTER COLUMN first_triggered_at SET NOT NULL;
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_event_id_key;
ALTER TABLE jobs DROP COLUMN event_id;

-- 部分 unique を張る前に、同一 scope の queued 重複は最新だけ残して cancel する（本番運用前の最小移行）
UPDATE jobs SET state = 'cancelled', updated_at = now()
WHERE state = 'queued' AND id NOT IN (
  SELECT DISTINCT ON (guild_id, channel_id, COALESCE(thread_id, '')) id
  FROM jobs WHERE state = 'queued'
  ORDER BY guild_id, channel_id, COALESCE(thread_id, ''), created_at DESC
);
CREATE UNIQUE INDEX jobs_scope_queued_idx
  ON jobs (kind, guild_id, channel_id, (COALESCE(thread_id, ''))) WHERE state = 'queued';

CREATE TABLE conversation_cursors (
  guild_id text NOT NULL, channel_id text NOT NULL,
  thread_id text NOT NULL DEFAULT '',  -- '' = 親チャンネル scope（PK にするため NULL の代わり）
  last_event_id uuid NOT NULL, last_occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (guild_id, channel_id, thread_id)
);

CREATE TABLE run_input_events (
  run_id uuid NOT NULL REFERENCES decision_runs(id),
  event_id uuid NOT NULL REFERENCES events(id),
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE actor_states (
  guild_id text NOT NULL, actor_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('observed', 'interacted')),
  first_observed_at timestamptz NOT NULL, last_interacted_at timestamptz,
  PRIMARY KEY (guild_id, actor_id)
);
```

補足: `conversation_cursors.last_event_id` に FK を張らないのは意図的（cursor は監査ではなく生きた状態で、将来の events purge を妨げないため。`run_input_events` は監査なので events と同じく FK で守る）。

- [ ] **Step 2: migrations.spec を更新**

`spec/adapters/postgres/migrations.spec.ts` の機械的更新:
- `["0001", "0002"]` を期待する4箇所（最初の it、並行実行 it、explicit context の it 2つ）をすべて `["0001", "0002", "0003"]` に。
- status 配列に `expect.objectContaining({ version: "0003", name: "conversation_evaluate", state: "applied" })` を追加。

新規テストを末尾に追加:

```ts
it("creates the conversation batch tables and enforces one queued job per scope", async () => {
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });

  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_name in ('conversation_cursors', 'run_input_events', 'actor_states') order by table_name
  `;
  expect(tables.map((table) => table.table_name)).toEqual(["actor_states", "conversation_cursors", "run_input_events"]);

  const jobColumns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_name = 'jobs'
      and column_name in ('event_id', 'guild_id', 'channel_id', 'thread_id', 'first_triggered_at', 'trigger_event_id')
    order by column_name
  `;
  expect(jobColumns.map((column) => column.column_name)).toEqual([
    "channel_id", "first_triggered_at", "guild_id", "thread_id", "trigger_event_id",
  ]);

  const now = new Date();
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values ('00000000-0000-4000-8000-0000000000aa', 1, 'discord', 'scope-guard', '0', 'message.created', 'mention_only', 'g', 'c', 'a', 'human', ${now}, ${now}, ${sql.json({ text: "hi" })}, ${now})`;
  await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) values ('00000000-0000-4000-8000-0000000000ab', 'conversation_evaluate', 'g', 'c', null, '00000000-0000-4000-8000-0000000000aa', 'queued', ${now}, ${now}, ${now}, ${now})`;
  await expect(
    sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) values ('00000000-0000-4000-8000-0000000000ac', 'conversation_evaluate', 'g', 'c', null, '00000000-0000-4000-8000-0000000000aa', 'queued', ${now}, ${now}, ${now}, ${now})`,
  ).rejects.toThrow(/jobs_scope_queued_idx/u);
});
```

- [ ] **Step 3: WIP commit**（この時点で他の DB spec は赤。想定どおり）

```bash
git add migrations spec/adapters/postgres/migrations.spec.ts && git commit -m "wip: migration 0003 conversation_evaluate schema"
```

#### 3b. ingest ドメインの書き換え

**Files:**
- Modify: `src/modules/events/ingest-message.ts`
- Rewrite: `spec/modules/events/ingest-message.spec.ts`

- [ ] **Step 4: `ingest-message.ts` を全面置換**

```ts
import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import type { ChannelCapabilities } from "../channels/channel-capability.js";
import type { BatchConfig } from "../conversations/batch-schedule.js";
import type { SystemMode } from "../system/system-control.js";
import type { CanonicalMessageEvent, DiscordMessageInput } from "./canonical-event.js";

const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ConversationEvaluateJobInput {
  id: string;
  kind: "conversation_evaluate";
  guildId: string;
  channelId: string;
  threadId: string | null;
  triggerEventId: string;
  priority: 100;
  firstTriggeredAt: Date;
  availableAt: Date; // now + batchWindow。既存 queued job と競合したら DB 側で maxWait 上限つき延長になる
  maxWaitMs: number;
  maxAttempts: 3;
}

export interface QueuedJobExtension {
  guildId: string;
  channelId: string;
  threadId: string | null;
  availableAt: Date; // now + batchWindow
  maxWaitMs: number;
  now: Date;
}

export type ConversationJobDirective =
  | { kind: "none" }
  | { kind: "enqueue"; job: ConversationEvaluateJobInput }
  | { kind: "extend"; extension: QueuedJobExtension };

export interface IngestionStore {
  saveEventAndSyncJob(
    event: CanonicalMessageEvent,
    directive: ConversationJobDirective,
  ): Promise<{ eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean }>;
}

export type IngestMessageResult =
  | { kind: "ignored"; reason: "channel_not_allowed" }
  | { kind: "accepted"; eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean };

export async function ingestDiscordMessage(
  input: DiscordMessageInput,
  capability: ChannelCapabilities,
  systemMode: SystemMode,
  batch: BatchConfig,
  store: IngestionStore,
  clock: Clock,
): Promise<IngestMessageResult> {
  if (capability.guildId !== input.guildId || capability.channelId !== input.channelId) {
    return { kind: "ignored", reason: "channel_not_allowed" };
  }
  const mentionAllowed = input.mentionedBot && input.actorKind === "human" && capability.respondToMentions;
  if (!capability.observeEvents && !mentionAllowed) return { kind: "ignored", reason: "channel_not_allowed" };

  const now = clock.now();
  const event: CanonicalMessageEvent = {
    id: newId(),
    schemaVersion: 1,
    source: "discord",
    externalEventId: input.externalEventId,
    externalVersion: input.externalVersion,
    kind: "message.created",
    visibility: capability.observeEvents ? "observed" : "mention_only",
    guildId: input.guildId,
    channelId: input.channelId,
    threadId: input.threadId,
    actorId: input.actorId,
    actorKind: input.actorKind,
    occurredAt: new Date(input.occurredAt),
    receivedAt: new Date(now),
    content: {
      text: input.content,
      mentionedBot: input.mentionedBot,
      mentionIds: [...input.mentionIds],
      replyToMessageId: input.replyToMessageId,
      attachments: input.attachments.map((attachment) => ({ ...attachment })),
    },
    expiresAt: new Date(now.getTime() + RAW_EVENT_RETENTION_MS),
  };
  const availableAt = new Date(now.getTime() + batch.batchWindowMs);
  const directive: ConversationJobDirective =
    systemMode === "stopped"
      ? { kind: "none" }
      : mentionAllowed
        ? {
            kind: "enqueue",
            job: {
              id: newId(),
              kind: "conversation_evaluate",
              guildId: input.guildId,
              channelId: input.channelId,
              threadId: input.threadId,
              triggerEventId: event.id,
              priority: 100,
              firstTriggeredAt: new Date(now),
              availableAt,
              maxWaitMs: batch.maxWaitMs,
              maxAttempts: 3,
            },
          }
        : {
            kind: "extend",
            extension: {
              guildId: input.guildId,
              channelId: input.channelId,
              threadId: input.threadId,
              availableAt,
              maxWaitMs: batch.maxWaitMs,
              now: new Date(now),
            },
          };
  const saved = await store.saveEventAndSyncJob(event, directive);
  return {
    kind: "accepted",
    eventId: saved.eventId,
    duplicate: saved.duplicate,
    jobQueued: saved.jobQueued,
    jobExtended: saved.jobExtended,
  };
}
```

- [ ] **Step 5: `spec/modules/events/ingest-message.spec.ts` を全面書き換え**

```ts
import { describe, expect, it, vi } from "vitest";
import { denyAllCapabilities } from "../../../src/modules/channels/channel-capability.js";
import type { CanonicalMessageEvent } from "../../../src/modules/events/canonical-event.js";
import {
  ingestDiscordMessage,
  type ConversationJobDirective,
  type IngestionStore,
} from "../../../src/modules/events/ingest-message.js";
import { FixedClock } from "../../../src/shared/clock.js";

const now = new Date("2026-08-04T00:00:00.000Z");
const clock = new FixedClock(now);
const batch = { batchWindowMs: 8_000, maxWaitMs: 30_000 };
const input = {
  externalEventId: "discord-message-1",
  externalVersion: "0",
  guildId: "g",
  channelId: "c",
  threadId: null,
  actorId: "u",
  actorKind: "human" as const,
  occurredAt: now,
  content: "@bot hi",
  mentionedBot: true,
  mentionIds: ["bot"],
  replyToMessageId: null,
  attachments: [],
};
const allowed = { ...denyAllCapabilities("g", "c"), observeEvents: true, respondToMentions: true };

function fakeStore(result = { duplicate: false, jobQueued: true, jobExtended: false }) {
  const calls: { event: CanonicalMessageEvent; directive: ConversationJobDirective }[] = [];
  const store: IngestionStore = {
    saveEventAndSyncJob: vi.fn(async (event, directive) => {
      calls.push({ event, directive });
      return { eventId: event.id, ...result };
    }),
  };
  return { store, calls };
}

describe("ingestDiscordMessage", () => {
  it("enqueues a scope-keyed conversation_evaluate job for an allowed mention", async () => {
    const { store, calls } = fakeStore();
    const result = await ingestDiscordMessage(input, allowed, "running", batch, store, clock);
    expect(result).toMatchObject({ kind: "accepted", jobQueued: true, jobExtended: false });
    const directive = calls[0]!.directive;
    expect(directive.kind).toBe("enqueue");
    if (directive.kind !== "enqueue") throw new Error("unreachable");
    expect(directive.job).toMatchObject({
      kind: "conversation_evaluate",
      guildId: "g",
      channelId: "c",
      threadId: null,
      triggerEventId: calls[0]!.event.id,
      priority: 100,
      maxWaitMs: 30_000,
      maxAttempts: 3,
    });
    expect(directive.job.firstTriggeredAt).toEqual(now);
    expect(directive.job.availableAt).toEqual(new Date("2026-08-04T00:00:08.000Z"));
  });

  it("extends the queued job for an observed non-mention message", async () => {
    const { store, calls } = fakeStore({ duplicate: false, jobQueued: false, jobExtended: true });
    const result = await ingestDiscordMessage(
      { ...input, mentionedBot: false, mentionIds: [] },
      allowed,
      "running",
      batch,
      store,
      clock,
    );
    expect(result).toMatchObject({ kind: "accepted", jobQueued: false, jobExtended: true });
    const directive = calls[0]!.directive;
    expect(directive.kind).toBe("extend");
    if (directive.kind !== "extend") throw new Error("unreachable");
    expect(directive.extension).toMatchObject({ guildId: "g", channelId: "c", threadId: null, maxWaitMs: 30_000 });
    expect(directive.extension.availableAt).toEqual(new Date("2026-08-04T00:00:08.000Z"));
  });

  it("saves the event without touching jobs while stopped", async () => {
    const { store, calls } = fakeStore({ duplicate: false, jobQueued: false, jobExtended: false });
    const result = await ingestDiscordMessage(input, allowed, "stopped", batch, store, clock);
    expect(result).toMatchObject({ kind: "accepted", jobQueued: false, jobExtended: false });
    expect(calls[0]!.directive).toEqual({ kind: "none" });
  });

  it("ignores messages outside observed or mention-allowed channels", async () => {
    const { store } = fakeStore();
    const denied = denyAllCapabilities("g", "c");
    await expect(
      ingestDiscordMessage({ ...input, mentionedBot: false }, denied, "running", batch, store, clock),
    ).resolves.toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(store.saveEventAndSyncJob).not.toHaveBeenCalled();
  });

  it("passes duplicate flags through", async () => {
    const { store } = fakeStore({ duplicate: true, jobQueued: false, jobExtended: false });
    await expect(ingestDiscordMessage(input, allowed, "running", batch, store, clock)).resolves.toMatchObject({
      duplicate: true,
      jobQueued: false,
    });
  });
});
```

#### 3c. ingestion store adapter

**Files:**
- Modify: `src/adapters/postgres/ingestion-store.ts`
- Modify: `spec/adapters/postgres/ingestion-store.spec.ts`

- [ ] **Step 6: `ingestion-store.ts` を全面置換**

```ts
import type { Sql } from "postgres";
import type { CanonicalMessageEvent } from "../../modules/events/canonical-event.js";
import type {
  ConversationJobDirective,
  IngestionStore,
  QueuedJobExtension,
} from "../../modules/events/ingest-message.js";

export class PostgresIngestionStore implements IngestionStore {
  public constructor(private readonly sql: Sql) {}

  public async saveEventAndSyncJob(
    event: CanonicalMessageEvent,
    directive: ConversationJobDirective,
  ): Promise<{ eventId: string; duplicate: boolean; jobQueued: boolean; jobExtended: boolean }> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<{ id: string }[]>`
        insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, thread_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at)
        values (${event.id}, ${event.schemaVersion}, ${event.source}, ${event.externalEventId}, ${event.externalVersion}, ${event.kind}, ${event.visibility}, ${event.guildId}, ${event.channelId}, ${event.threadId}, ${event.actorId}, ${event.actorKind}, ${event.occurredAt}, ${event.receivedAt}, ${transaction.json(JSON.parse(JSON.stringify(event.content)))}, ${event.expiresAt})
        on conflict (source, external_event_id, external_version) do nothing returning id
      `;
      if (!inserted[0]) {
        const existing = await transaction<
          { id: string }[]
        >`select id from events where source = ${event.source} and external_event_id = ${event.externalEventId} and external_version = ${event.externalVersion}`;
        if (!existing[0]) throw new Error("Duplicate event conflict could not find existing event");
        return { eventId: existing[0].id, duplicate: true, jobQueued: false, jobExtended: false };
      }
      let jobQueued = false;
      let jobExtended = false;
      if (directive.kind === "enqueue") {
        const job = directive.job;
        const rows = await transaction<{ inserted: boolean }[]>`
          insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, priority, state, available_at, first_triggered_at, attempts, max_attempts, created_at, updated_at)
          values (${job.id}, ${job.kind}, ${job.guildId}, ${job.channelId}, ${job.threadId}, ${job.triggerEventId}, ${job.priority}, 'queued', ${job.availableAt}, ${job.firstTriggeredAt}, 0, ${job.maxAttempts}, ${event.receivedAt}, ${event.receivedAt})
          on conflict (kind, guild_id, channel_id, (coalesce(thread_id, ''))) where state = 'queued'
          do update set available_at = least(${job.availableAt}, jobs.first_triggered_at + ${job.maxWaitMs} * interval '1 millisecond'), updated_at = ${event.receivedAt}
          returning (xmax = 0) as inserted
        `;
        jobQueued = rows[0]?.inserted === true;
        jobExtended = rows[0] !== undefined && !rows[0].inserted;
      } else if (directive.kind === "extend") {
        jobExtended = await extendQueuedJobIn(transaction, directive.extension);
      }
      return { eventId: event.id, duplicate: false, jobQueued, jobExtended };
    });
  }

  /** typing 延長（設計 §3.2）。queued job がなければ何もしない。 */
  public async extendQueuedJob(extension: QueuedJobExtension): Promise<boolean> {
    return extendQueuedJobIn(this.sql, extension);
  }
}

async function extendQueuedJobIn(sql: Sql, extension: QueuedJobExtension): Promise<boolean> {
  const rows = await sql`
    update jobs
    set available_at = least(${extension.availableAt}, first_triggered_at + ${extension.maxWaitMs} * interval '1 millisecond'), updated_at = ${extension.now}
    where kind = 'conversation_evaluate' and state = 'queued'
      and guild_id = ${extension.guildId} and channel_id = ${extension.channelId}
      and coalesce(thread_id, '') = ${extension.threadId ?? ""}
    returning id
  `;
  return rows.length > 0;
}
```

型注意: `extendQueuedJobIn` の `sql` は `Sql` と `TransactionSql` の両方を受けるので、実際のシグネチャは postgres.js の `Sql` 共通型（`Sql<Record<string, unknown>>` か、`Pick` した最小型）でコンパイルが通る形にする。通らなければ第1引数の型を `Sql | postgres.TransactionSql` 相当にする。

- [ ] **Step 7: `spec/adapters/postgres/ingestion-store.spec.ts` の `PostgresIngestionStore` describe を書き換え**

import から `MentionResponseJobInput` を消し、`ConversationEvaluateJobInput` / `ConversationJobDirective` に替える。`beforeEach` の truncate に `conversation_cursors, run_input_events, actor_states` を追加。既存のイベント永続化・重複検知のテストは `saveEventAndMaybeEnqueue(event, null)` → `saveEventAndSyncJob(event, { kind: "none" })` に機械置換。job 関連は以下のテストで置き換え・追加:

```ts
const now = new Date("2026-08-04T00:00:00.000Z");

function canonicalEvent(overrides: Partial<CanonicalMessageEvent> = {}): CanonicalMessageEvent {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    source: "discord",
    externalEventId: crypto.randomUUID(),
    externalVersion: "0",
    kind: "message.created",
    visibility: "observed",
    guildId: "g",
    channelId: "c",
    threadId: null,
    actorId: "u",
    actorKind: "human",
    occurredAt: now,
    receivedAt: now,
    content: { text: "hi", mentionedBot: true, mentionIds: [], replyToMessageId: null, attachments: [] },
    expiresAt: new Date("2026-09-04T00:00:00.000Z"),
    ...overrides,
  };
}

function enqueueDirective(event: CanonicalMessageEvent, availableAt: Date, firstTriggeredAt: Date) {
  return {
    kind: "enqueue" as const,
    job: {
      id: crypto.randomUUID(),
      kind: "conversation_evaluate" as const,
      guildId: event.guildId,
      channelId: event.channelId,
      threadId: event.threadId,
      triggerEventId: event.id,
      priority: 100 as const,
      firstTriggeredAt,
      availableAt,
      maxWaitMs: 30_000,
      maxAttempts: 3 as const,
    },
  };
}

it("creates one queued job per scope and extends it on a second mention", async () => {
  const store = new PostgresIngestionStore(sql);
  const first = canonicalEvent();
  const r1 = await store.saveEventAndSyncJob(first, enqueueDirective(first, new Date("2026-08-04T00:00:08Z"), now));
  expect(r1).toMatchObject({ jobQueued: true, jobExtended: false });

  const second = canonicalEvent({ receivedAt: new Date("2026-08-04T00:00:05Z") });
  const r2 = await store.saveEventAndSyncJob(
    second,
    enqueueDirective(second, new Date("2026-08-04T00:00:13Z"), new Date("2026-08-04T00:00:05Z")),
  );
  expect(r2).toMatchObject({ jobQueued: false, jobExtended: true });

  const jobs = await sql<{ trigger_event_id: string; first_triggered_at: Date; available_at: Date }[]>`
    select trigger_event_id, first_triggered_at, available_at from jobs where state = 'queued'
  `;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ trigger_event_id: first.id, first_triggered_at: now });
  expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:13Z"));
});

it("caps the extension at first_triggered_at + maxWait", async () => {
  const store = new PostgresIngestionStore(sql);
  const first = canonicalEvent();
  await store.saveEventAndSyncJob(first, enqueueDirective(first, new Date("2026-08-04T00:00:08Z"), now));
  const late = canonicalEvent({ content: { text: "追記", mentionedBot: false, mentionIds: [], replyToMessageId: null, attachments: [] } });
  const result = await store.saveEventAndSyncJob(late, {
    kind: "extend",
    extension: {
      guildId: "g", channelId: "c", threadId: null,
      availableAt: new Date("2026-08-04T00:00:36Z"), // now+28s 時点の候補 = 36s > cap 30s
      maxWaitMs: 30_000,
      now: new Date("2026-08-04T00:00:28Z"),
    },
  });
  expect(result).toMatchObject({ jobExtended: true });
  const jobs = await sql<{ available_at: Date }[]>`select available_at from jobs where state = 'queued'`;
  expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:30Z"));
});

it("keeps thread scopes separate and reports no extension without a queued job", async () => {
  const store = new PostgresIngestionStore(sql);
  const threadEvent = canonicalEvent({ threadId: "t1" });
  const r1 = await store.saveEventAndSyncJob(threadEvent, enqueueDirective(threadEvent, new Date("2026-08-04T00:00:08Z"), now));
  expect(r1).toMatchObject({ jobQueued: true });
  const parentEvent = canonicalEvent();
  const r2 = await store.saveEventAndSyncJob(parentEvent, {
    kind: "extend",
    extension: { guildId: "g", channelId: "c", threadId: null, availableAt: new Date("2026-08-04T00:00:09Z"), maxWaitMs: 30_000, now },
  });
  expect(r2).toMatchObject({ jobExtended: false }); // thread の job は親 scope の extend に反応しない
  const parentMention = canonicalEvent();
  const r3 = await store.saveEventAndSyncJob(parentMention, enqueueDirective(parentMention, new Date("2026-08-04T00:00:08Z"), now));
  expect(r3).toMatchObject({ jobQueued: true }); // 親 scope には新規 job が立つ
});

it("does not touch jobs for a duplicate event", async () => {
  const store = new PostgresIngestionStore(sql);
  const event = canonicalEvent();
  await store.saveEventAndSyncJob(event, enqueueDirective(event, new Date("2026-08-04T00:00:08Z"), now));
  const dup = { ...canonicalEvent(), externalEventId: event.externalEventId, externalVersion: event.externalVersion };
  const result = await store.saveEventAndSyncJob(dup, enqueueDirective(dup, new Date("2026-08-04T00:00:20Z"), now));
  expect(result).toMatchObject({ duplicate: true, jobQueued: false, jobExtended: false });
  const jobs = await sql<{ available_at: Date }[]>`select available_at from jobs`;
  expect(jobs[0]!.available_at).toEqual(new Date("2026-08-04T00:00:08Z"));
});
```

#### 3d. job queue（ドメイン型 + adapter）

**Files:**
- Modify: `src/modules/jobs/job-queue.ts`
- Modify: `src/adapters/postgres/job-queue.ts`
- Modify: `spec/adapters/postgres/job-queue.spec.ts`
- Modify: `src/modules/jobs/run-worker.test.ts`, `src/apps/app-lifecycle.test.ts`, `src/observability/logger.test.ts`（ClaimedJob 形の追随）

- [ ] **Step 8: `ClaimedJob` を scope 形に変更**

`src/modules/jobs/job-queue.ts`:

```ts
export interface ClaimedJob {
  id: string;
  kind: "conversation_evaluate";
  guildId: string;
  channelId: string;
  threadId: string | null;
  triggerEventId: string | null;
  firstTriggeredAt: Date;
  attempts: number;
  maxAttempts: number;
  leasedUntil: Date;
  leaseToken: string;
}

export interface JobQueue {
  claim(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null>;
  succeed(jobId: string, leaseToken: string, now: Date): Promise<void>;
  fail(jobId: string, leaseToken: string, error: string, retryable: boolean, now: Date): Promise<void>;
}
```

- [ ] **Step 9: `src/adapters/postgres/job-queue.ts` の claim を更新**

期限切れ掃除の select と audit の `event_id` 参照を `trigger_event_id` に変更:

```ts
const expiredJobs = await transaction<Array<{ id: string; trigger_event_id: string | null }>>`
  select id, trigger_event_id from jobs
  where state = 'running' and leased_until < ${now} and attempts >= max_attempts
  for update
`;
```

（audit insert の `${job.event_id}` → `${job.trigger_event_id}`）

claim の returning を新しい形に:

```ts
returning j.id, j.kind, j.guild_id as "guildId", j.channel_id as "channelId", j.thread_id as "threadId",
  j.trigger_event_id as "triggerEventId", j.first_triggered_at as "firstTriggeredAt",
  j.attempts, j.max_attempts as "maxAttempts", j.leased_until as "leasedUntil", j.lease_token as "leaseToken"
```

- [ ] **Step 10: `spec/adapters/postgres/job-queue.spec.ts` を追随**

- `insertJob` ヘルパーを新スキーマに（部分 unique に当たらないよう channel をイベント毎に分ける）:

```ts
async function insertJob(
  id: string,
  event: string,
  values: { priority: number; createdAt: Date; availableAt?: Date; attempts?: number; maxAttempts?: number; state?: string },
) {
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${event}, 1, 'discord', ${event}, '1', 'message.created', 'mention_only', 'g', ${event}, 'a', 'human', ${now}, ${now}, ${sql.json({ text: event })}, ${new Date("2026-02-01T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, priority, state, available_at, first_triggered_at, attempts, max_attempts, created_at, updated_at) values (${id}, 'conversation_evaluate', 'g', ${event}, null, ${event}, ${values.priority}, ${values.state ?? "queued"}, ${values.availableAt ?? now}, ${values.createdAt}, ${values.attempts ?? 0}, ${values.maxAttempts ?? 3}, ${values.createdAt}, ${now})`;
}
```

- `beforeEach` の直接 insert も同じ列構成に変更（channel `'c'`）。truncate に `conversation_cursors, run_input_events, actor_states` を追加。
- claim の期待値を `kind: "conversation_evaluate", guildId: "g", channelId: "c", threadId: null, triggerEventId: eventId, firstTriggeredAt: now` を含む形に更新。`eventId` プロパティへの言及は全削除。
- 期限切れ audit のテストが `event_id` 列を見ていれば `trigger_event_id` 経由の期待に更新。

- [ ] **Step 11: src 内の ClaimedJob fixture 追随**

`src/modules/jobs/run-worker.test.ts` / `src/apps/app-lifecycle.test.ts` / `src/observability/logger.test.ts` に出てくる fake ClaimedJob / job オブジェクトの `kind: "mention_response"` と `eventId` を、Step 8 の形（`kind: "conversation_evaluate"`, `guildId: "g"`, `channelId: "c"`, `threadId: null`, `triggerEventId: "..."`, `firstTriggeredAt: new Date(...)`）に機械更新する。`nr check` が通るまで。

- [ ] **Step 12: WIP commit**

```bash
git add -A && git commit -m "wip: scope-keyed jobs through ingest and queue"
```

#### 3e. worker ドメイン（evaluate-conversation）

**Files:**
- Create: `src/modules/conversations/evaluate-conversation.ts`
- Create: `src/modules/conversations/evaluate-conversation.test.ts`
- Delete: `src/modules/mentions/`

- [ ] **Step 13: `evaluate-conversation.ts` を作成**（`process-mention.ts` の後継。モデル呼び出しループはそのまま流用）

```ts
import type { Usage } from "@earendil-works/pi-ai";
import type { LoadedModelRoutes } from "../../config/model-routes.js";
import type { CharacterDefinition } from "../characters/character-definition.js";
import type { AgentRuntime } from "../models/agent-runtime.js";
import type { ClaimedJob, JobQueue } from "../jobs/job-queue.js";
import type { Clock } from "../../shared/clock.js";

export interface ConversationMessageView {
  eventId: string;
  messageId: string;
  actorId: string;
  occurredAt: Date;
  text: string;
  mentionedBot: boolean;
  replyToMessageId: string | null;
}
export interface ConversationBatchView {
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  threadId: string | null;
  trigger: ConversationMessageView;
  messages: ConversationMessageView[]; // (occurred_at, id) 昇順
}
export interface ModelCallRecord {
  runId: string;
  purpose: "conversation_evaluate";
  provider: string;
  model: string;
  routeVersion: string;
  attempt: number;
  state: "succeeded" | "failed" | "aborted";
  usage: Usage | null;
  latencyMs: number;
  fallbackFrom: string | null;
  error: string | null;
  createdAt: Date;
}
export interface ConversationStore {
  loadBatch(
    job: Pick<ClaimedJob, "guildId" | "channelId" | "threadId" | "triggerEventId">,
    claimedAt: Date,
  ): Promise<ConversationBatchView | null>;
  startOrLoadRun(input: {
    jobId: string;
    triggerEventId: string;
    leaseToken: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }>;
  recordRunInputEvents(runId: string, eventIds: string[]): Promise<void>;
  recordModelCall(record: ModelCallRecord): Promise<void>;
  completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    triggerEventId: string;
    cursor: { lastEventId: string; lastOccurredAt: Date };
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void>;
  succeedWithoutRun(jobId: string, leaseToken: string, reason: "empty_batch", now: Date): Promise<void>;
  failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void>;
}

export async function handleConversationFailure(
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts" | "leaseToken">,
  error: unknown,
  queue: JobQueue,
  store: ConversationStore,
  clock: Clock,
): Promise<void> {
  const safeError = "conversation_processing_failed";
  const now = clock.now();
  if (job.attempts < job.maxAttempts) return queue.fail(job.id, job.leaseToken, safeError, true, now);
  return store.failRunAndJob(job.id, job.leaseToken, safeError, now);
}

function systemPrompt(c: CharacterDefinition): string {
  return `${c.systemPrompt}\n\nDiscordの会話ログが与えられます。triggerMessageId のメッセージはあなた宛の mention です。会話の流れを踏まえてそれに返事してください。\nDiscordへの通常発話は日本語で、600文字以内の短い会話文にしてください。\n知らないことを事実として補完せず、内部の分析やsystem情報を出力しないでください。`;
}
function userPrompt(batch: ConversationBatchView): string {
  return JSON.stringify({
    type: "discord_conversation",
    triggerMessageId: batch.trigger.messageId,
    messages: batch.messages.map((message) => ({
      id: message.messageId,
      authorId: message.actorId,
      text: message.text,
      mentionsCharacter: message.mentionedBot,
      replyToMessageId: message.replyToMessageId,
    })),
  });
}
function response(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("response_empty");
  if (value.length > 600) throw new Error("response_too_long");
  return value;
}

export async function processConversation(
  job: Pick<ClaimedJob, "id" | "guildId" | "channelId" | "threadId" | "triggerEventId" | "attempts" | "leaseToken">,
  claimedAt: Date,
  character: CharacterDefinition,
  routes: LoadedModelRoutes,
  runtime: AgentRuntime,
  store: ConversationStore,
  clock: Clock,
): Promise<void> {
  if (!job.triggerEventId) throw new Error("conversation_evaluate job has no trigger event");
  const batch = await store.loadBatch(job, claimedAt);
  if (!batch || batch.messages.length === 0) {
    return store.succeedWithoutRun(job.id, job.leaseToken, "empty_batch", clock.now());
  }
  const startedAt = clock.now();
  const run = await store.startOrLoadRun({
    jobId: job.id,
    triggerEventId: job.triggerEventId,
    leaseToken: job.leaseToken,
    characterId: character.characterId,
    characterVersion: character.version,
    routeVersion: routes.version,
    now: startedAt,
  });
  if (run.state === "succeeded") return;
  if (run.state === "failed") throw new Error("Decision run is already terminal");
  await store.recordRunInputEvents(run.runId, batch.messages.map((message) => message.eventId));
  const last = batch.messages.at(-1)!;
  const cursor = { lastEventId: last.eventId, lastOccurredAt: last.occurredAt };
  const deadline = startedAt.getTime() + routes.mentionResponseDeadlineMs;
  let previous: string | null = null;
  for (const [index, target] of routes.mentionResponse.entries()) {
    const remaining = deadline - clock.now().getTime();
    if (remaining <= 0) break;
    const callStarted = clock.now();
    let result: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      result = await runtime.run({
        ...target,
        timeoutMs: Math.min(target.timeoutMs, remaining),
        systemPrompt: systemPrompt(character),
        userPrompt: userPrompt(batch),
      });
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "conversation_evaluate",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: error instanceof Error && "stopReason" in error && error.stopReason === "aborted" ? "aborted" : "failed",
        usage: null,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error:
          error instanceof Error && "stopReason" in error && error.stopReason === "aborted"
            ? "model_aborted"
            : "model_runtime_failed",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    let content: string;
    try {
      content = response(result.text);
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "conversation_evaluate",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: "failed",
        usage: result.usage,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error: error instanceof Error && error.message === "response_too_long" ? "response_too_long" : "response_empty",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    await store.recordModelCall({
      runId: run.runId,
      purpose: "conversation_evaluate",
      provider: result.provider,
      model: result.model,
      routeVersion: routes.version,
      attempt: index + 1,
      state: "succeeded",
      usage: result.usage,
      latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
      fallbackFrom: previous,
      error: null,
      createdAt: clock.now(),
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: job.id,
      leaseToken: job.leaseToken,
      triggerEventId: job.triggerEventId,
      cursor,
      content,
      fallback: false,
      now: clock.now(),
    });
    return;
  }
  await store.completeWithReply({
    runId: run.runId,
    jobId: job.id,
    leaseToken: job.leaseToken,
    triggerEventId: job.triggerEventId,
    cursor,
    content: character.failureMessages[0]!,
    fallback: true,
    now: clock.now(),
  });
}
```

- [ ] **Step 14: unit test を作成し、mentions ディレクトリを削除**

`src/modules/conversations/evaluate-conversation.test.ts` は `src/modules/mentions/process-mention.test.ts` を土台に書き換える。fake store を新 interface に合わせ、以下を検証する（旧テストの fallback / deadline / terminal-run ケースは同等に移植）:

```ts
const batch = {
  guildId: "g",
  capabilityChannelId: "c",
  targetChannelId: "c",
  threadId: null,
  trigger: { eventId: "event-1", messageId: "m1", actorId: "u", occurredAt: new Date("2026-08-04T00:00:00Z"), text: "@bot hi", mentionedBot: true, replyToMessageId: null },
  messages: [
    { eventId: "event-1", messageId: "m1", actorId: "u", occurredAt: new Date("2026-08-04T00:00:00Z"), text: "@bot hi", mentionedBot: true, replyToMessageId: null },
    { eventId: "event-2", messageId: "m2", actorId: "u", occurredAt: new Date("2026-08-04T00:00:03Z"), text: "続き", mentionedBot: false, replyToMessageId: null },
  ],
};
function store(loaded: typeof batch | null = batch): ConversationStore {
  return {
    loadBatch: vi.fn().mockResolvedValue(loaded),
    startOrLoadRun: vi.fn().mockResolvedValue({ runId: "run-1", state: "running" }),
    recordRunInputEvents: vi.fn(),
    recordModelCall: vi.fn(),
    completeWithReply: vi.fn(),
    succeedWithoutRun: vi.fn(),
    failRunAndJob: vi.fn(),
  };
}
const job = { id: "job-1", guildId: "g", channelId: "c", threadId: null, triggerEventId: "event-1", attempts: 1, maxAttempts: 3, leaseToken: "token" };
const claimedAt = new Date("2026-08-04T00:00:08Z");
```

必須ケース:
1. 成功時: `recordRunInputEvents("run-1", ["event-1", "event-2"])` が呼ばれ、`completeWithReply` の `cursor` が `{ lastEventId: "event-2", lastOccurredAt: batch の m2 の occurredAt }`、`triggerEventId: "event-1"` になる。`runtime.run` に渡った `userPrompt` に `"triggerMessageId":"m1"` と両メッセージが含まれる。
2. `loadBatch` が `null` → `succeedWithoutRun(job.id, "token", "empty_batch", ...)` が呼ばれ、`startOrLoadRun` は呼ばれない。
3. `triggerEventId: null` の job → throw。
4. 全ルート失敗 → `completeWithReply` が `fallback: true` / `content: 失敗メッセージ` で呼ばれる（旧テスト移植）。
5. `handleConversationFailure`: attempts < max → `queue.fail(..., "conversation_processing_failed", true, ...)`、attempts == max → `store.failRunAndJob`（旧テスト移植）。

```bash
git rm -r src/modules/mentions
```

#### 3f. decision-effect-store adapter

**Files:**
- Modify: `src/adapters/postgres/decision-effect-store.ts`
- Modify: `spec/adapters/postgres/decision-effect-store.spec.ts`

- [ ] **Step 15: `decision-effect-store.ts` を全面置換**

```ts
import type { Sql } from "postgres";
import { z } from "zod";
import { DiscordReplyPayloadSchema } from "../../modules/effects/effect.js";
import type {
  ConversationBatchView,
  ConversationMessageView,
  ConversationStore,
  ModelCallRecord,
} from "../../modules/conversations/evaluate-conversation.js";
import { newId } from "../../shared/ids.js";

const EventContent = z.strictObject({
  text: z.string(),
  mentionedBot: z.boolean(),
  mentionIds: z.array(z.string()),
  replyToMessageId: z.string().nullable(),
  attachments: z.array(z.unknown()),
});
const allowedErrors = new Set([
  "model_runtime_failed",
  "model_aborted",
  "response_empty",
  "response_too_long",
  "conversation_processing_failed",
]);
const bounded = (value: string) => (allowedErrors.has(value) ? value : "conversation_processing_failed").slice(0, 2000);

interface EventRow {
  id: string;
  external_event_id: string;
  actor_id: string;
  occurred_at: Date;
  content: unknown;
}
function toMessageView(row: EventRow): ConversationMessageView {
  const content = EventContent.parse(row.content);
  return {
    eventId: row.id,
    messageId: row.external_event_id,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    text: content.text,
    mentionedBot: content.mentionedBot,
    replyToMessageId: content.replyToMessageId,
  };
}

export class PostgresDecisionEffectStore implements ConversationStore {
  constructor(private readonly sql: Sql) {}

  async loadBatch(
    job: { guildId: string; channelId: string; threadId: string | null; triggerEventId: string | null },
    claimedAt: Date,
  ): Promise<ConversationBatchView | null> {
    if (!job.triggerEventId) throw new Error("conversation_evaluate job has no trigger event");
    const triggerRows = await this.sql<
      Array<EventRow & { kind: string; visibility: string; guild_id: string; channel_id: string; thread_id: string | null; actor_kind: string }>
    >`select id, kind, visibility, external_event_id, guild_id, channel_id, thread_id, actor_id, actor_kind, occurred_at, content from events where id = ${job.triggerEventId}`;
    const trigger = triggerRows[0];
    if (
      !trigger ||
      trigger.kind !== "message.created" ||
      !["observed", "mention_only"].includes(trigger.visibility) ||
      trigger.actor_kind !== "human"
    )
      throw new Error(`Invalid trigger event: ${job.triggerEventId}`);
    const triggerView = toMessageView(trigger);
    if (!triggerView.mentionedBot) throw new Error(`Trigger event is not a mention: ${job.triggerEventId}`);

    const cursors = await this.sql<{ last_event_id: string; last_occurred_at: Date }[]>`
      select last_event_id, last_occurred_at from conversation_cursors
      where guild_id = ${job.guildId} and channel_id = ${job.channelId} and thread_id = ${job.threadId ?? ""}
    `;
    const cursor = cursors[0];
    const rows = await this.sql<EventRow[]>`
      select id, external_event_id, actor_id, occurred_at, content from events
      where guild_id = ${job.guildId} and channel_id = ${job.channelId}
        and coalesce(thread_id, '') = ${job.threadId ?? ""}
        and kind = 'message.created'
        and occurred_at <= ${claimedAt}
        ${cursor ? this.sql`and (occurred_at, id) > (${cursor.last_occurred_at}, ${cursor.last_event_id}::uuid)` : this.sql``}
      order by occurred_at, id
    `;
    if (rows.length === 0) return null;
    return {
      guildId: trigger.guild_id,
      capabilityChannelId: trigger.channel_id,
      targetChannelId: trigger.thread_id ?? trigger.channel_id,
      threadId: trigger.thread_id,
      trigger: triggerView,
      messages: rows.map(toMessageView),
    };
  }

  async startOrLoadRun(input: {
    jobId: string;
    triggerEventId: string;
    leaseToken: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }> {
    return this.sql.begin(async (tx) => {
      const jobs = await tx<
        Array<{ trigger_event_id: string | null }>
      >`select trigger_event_id from jobs where id = ${input.jobId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} for update`;
      if (!jobs[0] || jobs[0].trigger_event_id !== input.triggerEventId) throw new Error("Lease lost");
      await tx`insert into decision_runs (id, job_id, event_id, character_id, character_version, state, model_route_version, started_at) values (${newId()}, ${input.jobId}, ${input.triggerEventId}, ${input.characterId}, ${input.characterVersion}, 'running', ${input.routeVersion}, ${input.now}) on conflict (job_id) do nothing`;
      const rows = await tx<
        Array<{ id: string; state: "running" | "succeeded" | "failed"; event_id: string; character_id: string; character_version: number; model_route_version: string }>
      >`select id, state, event_id, character_id, character_version, model_route_version from decision_runs where job_id = ${input.jobId}`;
      const row = rows[0];
      if (!row) throw new Error("Decision run disappeared");
      if (
        row.event_id !== input.triggerEventId ||
        row.character_id !== input.characterId ||
        row.character_version !== input.characterVersion ||
        row.model_route_version !== input.routeVersion
      )
        throw new Error("Decision run metadata mismatch");
      return { runId: row.id, state: row.state };
    });
  }

  async recordRunInputEvents(runId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.sql`
      insert into run_input_events (run_id, event_id)
      select ${runId}, unnest(${this.sql.array(eventIds)}::uuid[])
      on conflict do nothing
    `;
  }

  async recordModelCall(record: ModelCallRecord): Promise<void> {
    // Phase 1 と同一（purpose の型だけ変わる）。既存実装をそのまま残す。
  }

  async completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    triggerEventId: string;
    cursor: { lastEventId: string; lastOccurredAt: Date };
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void> {
    const payload = DiscordReplyPayloadSchema.parse({
      content: input.content,
      allowedMentions: { parse: [], repliedUser: false },
    });
    await this.sql.begin(async (tx) => {
      const canonicalJob = await tx<
        Array<{ trigger_event_id: string | null; guild_id: string; channel_id: string; thread_id: string | null }>
      >`select trigger_event_id, guild_id, channel_id, thread_id from jobs where id = ${input.jobId} for update`;
      if (!canonicalJob[0] || canonicalJob[0].trigger_event_id !== input.triggerEventId)
        throw new Error("Invalid job event");
      const runs = await tx<
        Array<{ state: string; job_id: string; event_id: string }>
      >`select state, job_id, event_id from decision_runs where id = ${input.runId} for update`;
      const run = runs[0];
      if (!run || run.job_id !== input.jobId || run.event_id !== input.triggerEventId || run.state === "failed")
        throw new Error("Invalid decision run");
      if (run.state === "succeeded") {
        const existing = await tx`select 1 from effects where run_id = ${input.runId} and effect_slot = 'primary_reply'`;
        if (existing.length) return;
        throw new Error("Succeeded run has no primary effect");
      }
      const jobUpdate =
        await tx`update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${input.now} where id = ${input.jobId} and trigger_event_id = ${input.triggerEventId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} returning id`;
      if (!jobUpdate.length) throw new Error("Lease lost");
      await tx`update decision_runs set state = 'succeeded', action_kind = 'reply', reason_codes = ${tx.array(["explicit_mention", input.fallback ? "model_fallback" : "model_response"])}, finished_at = ${input.now} where id = ${input.runId}`;
      const eventRows = await tx<
        Array<{ guild_id: string; channel_id: string; thread_id: string | null; external_event_id: string; actor_kind: string; kind: string; visibility: string; content: unknown }>
      >`select guild_id, channel_id, thread_id, external_event_id, actor_kind, kind, visibility, content from events where id = ${input.triggerEventId}`;
      const event = eventRows[0];
      if (
        !event ||
        event.kind !== "message.created" ||
        !["observed", "mention_only"].includes(event.visibility) ||
        event.actor_kind !== "human" ||
        !EventContent.safeParse(event.content).success
      )
        throw new Error("Invalid trigger event");
      const effects = await tx<
        Array<{ id: string }>
      >`insert into effects (id, run_id, effect_slot, kind, state, guild_id, capability_channel_id, target_channel_id, thread_id, target_message_id, payload, capability_decision, created_at, updated_at) values (${newId()}, ${input.runId}, 'primary_reply', 'discord.reply', 'planned', ${event.guild_id}, ${event.channel_id}, ${event.thread_id ?? event.channel_id}, ${event.thread_id}, ${event.external_event_id}, ${tx.json(payload)}, ${tx.json({ action: "respond_to_mention", allowed: true })}, ${input.now}, ${input.now}) returning id`;
      await tx`
        insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at)
        values (${canonicalJob[0].guild_id}, ${canonicalJob[0].channel_id}, ${canonicalJob[0].thread_id ?? ""}, ${input.cursor.lastEventId}, ${input.cursor.lastOccurredAt}, ${input.now})
        on conflict (guild_id, channel_id, thread_id) do update
        set last_event_id = excluded.last_event_id, last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at
        where (conversation_cursors.last_occurred_at, conversation_cursors.last_event_id) < (excluded.last_occurred_at, excluded.last_event_id)
      `;
      await tx`insert into audit_entries (id, category, event_id, job_id, run_id, effect_id, summary, created_at) values (${newId()}, 'decision.completed', ${input.triggerEventId}, ${input.jobId}, ${input.runId}, ${effects[0]!.id}, ${tx.json({ action: "reply", fallback: input.fallback })}, ${input.now})`;
    });
  }

  async succeedWithoutRun(jobId: string, leaseToken: string, reason: "empty_batch", now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const jobs = await tx<
        Array<{ trigger_event_id: string | null }>
      >`update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now} where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now} returning trigger_event_id`;
      if (!jobs[0]) throw new Error("Job lease lost");
      await tx`insert into audit_entries (id, category, event_id, job_id, summary, created_at) values (${newId()}, 'decision.skipped', ${jobs[0].trigger_event_id}, ${jobId}, ${tx.json({ reason })}, ${now})`;
    });
  }

  async failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void> {
    // Phase 1 実装のまま（bounded の語彙だけ conversation_processing_failed に変わっている）
  }
}
```

（`recordModelCall` と `failRunAndJob` の本体は既存コードを残す。コメントはこの計画の説明であって、実ファイルには書かない。）

- [ ] **Step 16: `spec/adapters/postgres/decision-effect-store.spec.ts` を追随**

- `fixture()` の jobs insert を新列構成に:

```ts
await sql`insert into jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, leased_until, lease_owner, lease_token, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'conversation_evaluate', 'g', 'c', null, ${eventId}, 'running', ${now}, ${now}, ${leasedUntil}, 'worker', ${leaseToken}, 1, 3, ${now}, ${now})`;
```

- `startOrLoadRun` 呼び出しの `eventId:` を `triggerEventId:` に、`completeWithReply` 入力に `triggerEventId: f.eventId` と `cursor: { lastEventId: f.eventId, lastOccurredAt: f.now }` を追加（全呼び出し箇所）。
- thread ケースのテストでは events だけでなく `update jobs set channel_id = 'parent', thread_id = 'thread-1'` も行う。
- `beforeEach` truncate に `conversation_cursors, run_input_events, actor_states` を追加。
- 新規テストを追加:

```ts
it("reads the batch after the cursor and up to the claim time", async () => {
  const f = await fixture();
  const store = new PostgresDecisionEffectStore(sql);
  const insertEvent = async (id: string, occurredAt: Date, text: string, mentioned = false) =>
    sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${id}, 1, 'discord', ${id}, '0', 'message.created', 'observed', 'g', 'c', 'u', 'human', ${occurredAt}, ${occurredAt}, ${sql.json({ text, mentionedBot: mentioned, mentionIds: [], replyToMessageId: null, attachments: [] })}, ${new Date("2026-08-22T00:00:00Z")})`;
  const before = "00000000-0000-4000-8000-000000000030";
  const after = "00000000-0000-4000-8000-000000000031";
  const late = "00000000-0000-4000-8000-000000000032";
  await insertEvent(before, new Date("2026-07-22T23:59:00Z"), "cursor 以前");
  await insertEvent(after, new Date("2026-07-23T00:00:03Z"), "batch 内");
  await insertEvent(late, new Date("2026-07-23T00:00:20Z"), "claim 後");
  await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', ${before}, ${new Date("2026-07-22T23:59:00Z")}, ${f.now})`;

  const batch = await store.loadBatch(
    { guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId },
    new Date("2026-07-23T00:00:10Z"),
  );
  expect(batch!.messages.map((message) => message.eventId)).toEqual([f.eventId, after]);
  expect(batch!.trigger.eventId).toBe(f.eventId);
});

it("returns null when the cursor has consumed everything", async () => {
  const f = await fixture();
  const store = new PostgresDecisionEffectStore(sql);
  await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', ${f.eventId}, ${f.now}, ${f.now})`;
  await expect(
    store.loadBatch({ guildId: "g", channelId: "c", threadId: null, triggerEventId: f.eventId }, new Date("2026-07-23T00:00:10Z")),
  ).resolves.toBeNull();
});

it("records run input events idempotently", async () => {
  const f = await fixture();
  const store = new PostgresDecisionEffectStore(sql);
  const run = await store.startOrLoadRun({ jobId: f.jobId, triggerEventId: f.eventId, leaseToken: f.leaseToken, characterId: "primary", characterVersion: 1, routeVersion: "route-v1", now: f.now });
  await store.recordRunInputEvents(run.runId, [f.eventId]);
  await store.recordRunInputEvents(run.runId, [f.eventId]);
  await expect(sql`select count(*)::int as count from run_input_events where run_id = ${run.runId}`).resolves.toEqual([{ count: 1 }]);
});

it("advances the cursor on completion and never moves it backwards", async () => {
  const f = await fixture();
  const store = new PostgresDecisionEffectStore(sql);
  const run = await store.startOrLoadRun({ jobId: f.jobId, triggerEventId: f.eventId, leaseToken: f.leaseToken, characterId: "primary", characterVersion: 1, routeVersion: "route-v1", now: f.now });
  await store.completeWithReply({ runId: run.runId, jobId: f.jobId, leaseToken: f.leaseToken, triggerEventId: f.eventId, cursor: { lastEventId: f.eventId, lastOccurredAt: f.now }, content: "返事", fallback: false, now: f.now });
  const cursors = await sql<{ last_event_id: string }[]>`select last_event_id from conversation_cursors where guild_id = 'g' and channel_id = 'c' and thread_id = ''`;
  expect(cursors).toEqual([{ last_event_id: f.eventId }]);
  // 後退させようとしても動かない
  await sql`update conversation_cursors set last_occurred_at = ${new Date("2026-07-23T01:00:00Z")} where guild_id = 'g'`;
  // （completeWithReply は succeeded 短絡で二重実行済みのため、ここでは直接 upsert の guard を確認する）
  await sql`insert into conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) values ('g', 'c', '', ${f.eventId}, ${f.now}, ${f.now}) on conflict (guild_id, channel_id, thread_id) do update set last_occurred_at = excluded.last_occurred_at where (conversation_cursors.last_occurred_at, conversation_cursors.last_event_id) < (excluded.last_occurred_at, excluded.last_event_id)`;
  await expect(sql`select last_occurred_at from conversation_cursors where guild_id = 'g'`).resolves.toEqual([
    { last_occurred_at: new Date("2026-07-23T01:00:00Z") },
  ]);
});

it("succeeds a job without a run for an empty batch", async () => {
  const f = await fixture();
  const store = new PostgresDecisionEffectStore(sql);
  await store.succeedWithoutRun(f.jobId, f.leaseToken, "empty_batch", f.now);
  await expect(sql`select state from jobs where id = ${f.jobId}`).resolves.toEqual([{ state: "succeeded" }]);
  await expect(sql`select count(*)::int as count from decision_runs`).resolves.toEqual([{ count: 0 }]);
  await expect(sql`select summary from audit_entries where category = 'decision.skipped'`).resolves.toEqual([
    { summary: { reason: "empty_batch" } },
  ]);
});
```

#### 3g. 配線（config / gateway / worker / e2e）

**Files:**
- Modify: `src/config/runtime-config.ts`, `src/config/runtime-config.test.ts`
- Modify: `src/apps/discord-gateway.ts`, `src/apps/cognition-worker.ts`
- Modify: `spec/apps/discord-gateway.spec.ts`（config 形の追随のみ）
- Rename: `spec/e2e/mention-response.spec.ts` → `spec/e2e/conversation-evaluate.spec.ts`

- [ ] **Step 17: gateway config に batch パラメータを追加**

`src/config/runtime-config.ts` の `loadGatewayConfig` の extend に追加:

```ts
VICISSITUDE_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(DEFAULT_BATCH_CONFIG.batchWindowMs),
VICISSITUDE_MAX_WAIT_MS: z.coerce.number().int().positive().default(DEFAULT_BATCH_CONFIG.maxWaitMs),
```

（`import { DEFAULT_BATCH_CONFIG } from "../modules/conversations/batch-schedule.js";`）

parse 後に検証を追加:

```ts
if (value.VICISSITUDE_MAX_WAIT_MS < value.VICISSITUDE_BATCH_WINDOW_MS)
  throw new Error("VICISSITUDE_MAX_WAIT_MS must be >= VICISSITUDE_BATCH_WINDOW_MS");
```

return に追加:

```ts
batch: { batchWindowMs: value.VICISSITUDE_BATCH_WINDOW_MS, maxWaitMs: value.VICISSITUDE_MAX_WAIT_MS },
```

`runtime-config.test.ts` にケース追加: デフォルトが `{ batchWindowMs: 8000, maxWaitMs: 30000 }` になること、`VICISSITUDE_MAX_WAIT_MS=5000`（< batchWindow）が throw すること。

- [ ] **Step 18: gateway / worker の呼び出しを更新**

`src/apps/discord-gateway.ts` の `onMessage` 内:

```ts
const result = await ingestDiscordMessage(input, capability, mode.mode, config.batch, ingestion, SystemClock);
```

（`logger.debug` の accepted 分岐に `jobExtended: result.jobExtended` を追加）

`src/apps/cognition-worker.ts` のループ本体:

```ts
const now = d.now();
const handled = await runWorkerIteration(
  queue,
  config.workerId,
  now,
  (job) => processConversation(job, now, character, routes, runtime, store, { now: d.now }),
  (job, error) => handleConversationFailure(job, error, queue, store, { now: d.now }),
);
```

import を `processConversation, handleConversationFailure`（`../modules/conversations/evaluate-conversation.js`）に変更。

`spec/apps/discord-gateway.spec.ts` で gateway config をリテラルで組み立てている箇所があれば `batch: { batchWindowMs: 8_000, maxWaitMs: 30_000 }` を追加（`loadGatewayConfig` 経由ならデフォルトが効くので変更不要）。

- [ ] **Step 19: e2e を書き換え**

`git mv spec/e2e/mention-response.spec.ts spec/e2e/conversation-evaluate.spec.ts`。既存2テストの変更点:
- import: `processMention` → `processConversation`（`../../src/modules/conversations/evaluate-conversation.js`）
- truncate に `conversation_cursors, run_input_events, actor_states` を追加
- job は `available_at = now + 8s` になるので claim は `const claimAt = new Date(now.getTime() + 8_000);` で行い、`processConversation(job!, claimAt, definition, {...}, runtime, store, clock)` を呼ぶ
- counts の期待に `run_input_events`（1件）と `conversation_cursors`（1件）を追加

batch を検証する新テストを追加:

```ts
it("batches a follow-up message into one reply and advances the cursor", async () => {
  const capabilities = await arrange();
  const ingestion = new PostgresIngestionStore(sql);
  const capability = await capabilities.get("g", "c");
  const batch = { batchWindowMs: 8_000, maxWaitMs: 30_000 };
  const first = await ingestDiscordMessage(input, capability, "running", batch, ingestion, clock);
  expect(first).toMatchObject({ jobQueued: true });

  const followUpAt = new Date(now.getTime() + 3_000);
  const followUp = await ingestDiscordMessage(
    { ...input, externalEventId: "discord-message-followup", occurredAt: followUpAt, content: "この前の漫画の話なんだけど", mentionedBot: false, mentionIds: [] },
    capability,
    "running",
    batch,
    new FixedClock(followUpAt),
  //                ^ FixedClock を followUpAt で作る（clock 引数）
  );
  expect(followUp).toMatchObject({ jobQueued: false, jobExtended: true });
  await expect(sql`select available_at from jobs where state = 'queued'`).resolves.toEqual([
    { available_at: new Date(followUpAt.getTime() + 8_000) },
  ]);

  const queue = new PostgresJobQueue(sql);
  expect(await queue.claim("worker", new Date(now.getTime() + 8_000), 60_000)).toBeNull(); // まだ延長中
  const claimAt = new Date(followUpAt.getTime() + 8_000);
  const job = await queue.claim("worker", claimAt, 60_000);
  expect(job).toMatchObject({ kind: "conversation_evaluate", guildId: "g", channelId: "c" });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("なるほど、続き聞かせて")]);
  await processConversation(
    job!,
    claimAt,
    definition,
    {
      version: "route-v1",
      mentionResponseDeadlineMs: 25_000,
      mentionResponse: [{ provider: faux.provider.id, model: faux.getModel().id, thinkingLevel: "off", timeoutMs: 5_000 }],
    },
    new PiAgentRuntime(models),
    new PostgresDecisionEffectStore(sql),
    new FixedClock(claimAt),
  );

  await expect(sql`select count(*)::int as count from run_input_events`).resolves.toEqual([{ count: 2 }]);
  const cursors = await sql<{ last_occurred_at: Date }[]>`select last_occurred_at from conversation_cursors`;
  expect(cursors[0]!.last_occurred_at).toEqual(followUpAt);
  const effects = await sql<{ target_message_id: string }[]>`select target_message_id from effects`;
  expect(effects).toEqual([{ target_message_id: "discord-message-1" }]); // reply は trigger 宛
});
```

（followUp の ingest 呼び出しは実際には `ingestDiscordMessage(input2, capability, "running", batch, ingestion, new FixedClock(followUpAt))` の6引数。上のインラインコメントは計画上の注記であり実コードには書かない。）

- [ ] **Step 20: 全体 green 化と commit**

Run: `nr check` → PASS、`nr test:unit` → PASS、`nr test:spec` → PASS（migrations / job-queue / ingestion-store / decision-effect-store / e2e / corpus / gateway すべて）
残ったコンパイルエラー・spec の `mention_response` 参照はここで潰し切る（`grep -rn "mention_response\|processMention\|eventId" src spec` で `model-routes` 関連以外の残骸ゼロを確認）。

```bash
git add -A && git commit -m "feat: replace mention_response with scope-keyed conversation_evaluate batching"
```

---

### Task 4: typing 延長（設計 §3.2、同じ式）

**Files:**
- Modify: `src/adapters/discord/message-snapshot.ts` / `message-snapshot.test.ts`
- Modify: `src/apps/discord-gateway.ts` / `src/apps/discord-gateway.test.ts`（registerGatewayListeners の形）

- [ ] **Step 1: typing scope 変換の failing test**

`src/adapters/discord/message-snapshot.test.ts` に追加:

```ts
describe("toTypingScope", () => {
  it("maps a thread typing event to the parent-channel scope with threadId", () => {
    expect(
      toTypingScope({ guildId: "g", channelId: "t", parentChannelId: "c", isThread: true, userIsBot: false }),
    ).toEqual({ guildId: "g", channelId: "c", threadId: "t" });
  });
  it("maps a plain channel typing event", () => {
    expect(
      toTypingScope({ guildId: "g", channelId: "c", parentChannelId: null, isThread: false, userIsBot: false }),
    ).toEqual({ guildId: "g", channelId: "c", threadId: null });
  });
  it("returns null for DMs, bots, and threads without a parent", () => {
    expect(toTypingScope({ guildId: null, channelId: "c", parentChannelId: null, isThread: false, userIsBot: false })).toBeNull();
    expect(toTypingScope({ guildId: "g", channelId: "c", parentChannelId: null, isThread: false, userIsBot: true })).toBeNull();
    expect(toTypingScope({ guildId: "g", channelId: "t", parentChannelId: null, isThread: true, userIsBot: false })).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗確認 → 実装**

`src/adapters/discord/message-snapshot.ts` に追加:

```ts
import type { ConversationScope } from "../../modules/conversations/scope.js";

export interface DiscordTypingSnapshot {
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
  userIsBot: boolean;
}

export function toTypingScope(snapshot: DiscordTypingSnapshot): ConversationScope | null {
  if (!snapshot.guildId || snapshot.userIsBot) return null;
  if (snapshot.isThread && !snapshot.parentChannelId) return null;
  return {
    guildId: snapshot.guildId,
    channelId: snapshot.isThread ? snapshot.parentChannelId! : snapshot.channelId,
    threadId: snapshot.isThread ? snapshot.channelId : null,
  };
}
```

Run: `nr test:unit` → PASS

- [ ] **Step 3: gateway に typingStart を配線**

`src/apps/discord-gateway.ts`:
- `registerGatewayListeners` に `typingStart` を追加:

```ts
export function registerGatewayListeners(
  client: { on(event: string, listener: (...args: any[]) => void): unknown },
  handlers: {
    messageCreate: (...args: any[]) => void;
    interactionCreate: (...args: any[]) => void;
    typingStart: (...args: any[]) => void;
  },
): void {
  client.on("messageCreate", handlers.messageCreate);
  client.on("interactionCreate", handlers.interactionCreate);
  client.on("typingStart", handlers.typingStart);
}
```

- `runGateway` 内にハンドラ追加（`onInteraction` の後）。best-effort なので失敗は warn 止まりで fatal にしない:

```ts
const onTyping = (typing: import("discord.js").Typing) => {
  if (!accepting.value) return;
  const scope = toTypingScope({
    guildId: typing.guild?.id ?? null,
    channelId: typing.channel.id,
    parentChannelId: typing.channel.isThread() ? typing.channel.parentId : null,
    isThread: typing.channel.isThread(),
    userIsBot: typing.user.bot ?? false,
  });
  if (!scope || scope.guildId !== config.guildId) return;
  const now = SystemClock.now();
  inflight
    .track(
      ingestion.extendQueuedJob({
        ...scope,
        availableAt: new Date(now.getTime() + config.batch.batchWindowMs),
        maxWaitMs: config.batch.maxWaitMs,
        now,
      }),
    )
    .catch((error) => logger.warn({ err: error }, "Typing extension failed"));
};
```

- `registerGatewayListeners(client, { messageCreate: ..., interactionCreate: ..., typingStart: onTyping as never });`
- `main()` の intents に `GatewayIntentBits.GuildMessageTyping` を追加。
- `src/apps/discord-gateway.test.ts` で `registerGatewayListeners` を直接テストしていれば `typingStart` ハンドラの登録検証を追加。

- [ ] **Step 4: DB レベルの延長検証を ingestion-store.spec に追加**

```ts
it("extends the queued job on typing via extendQueuedJob", async () => {
  const store = new PostgresIngestionStore(sql);
  const event = canonicalEvent();
  await store.saveEventAndSyncJob(event, enqueueDirective(event, new Date("2026-08-04T00:00:08Z"), now));
  const extended = await store.extendQueuedJob({
    guildId: "g", channelId: "c", threadId: null,
    availableAt: new Date("2026-08-04T00:00:12Z"), maxWaitMs: 30_000, now: new Date("2026-08-04T00:00:04Z"),
  });
  expect(extended).toBe(true);
  await expect(sql`select available_at from jobs where state = 'queued'`).resolves.toEqual([
    { available_at: new Date("2026-08-04T00:00:12Z") },
  ]);
  expect(
    await store.extendQueuedJob({ guildId: "g", channelId: "other", threadId: null, availableAt: now, maxWaitMs: 30_000, now }),
  ).toBe(false);
});
```

- [ ] **Step 5: green 確認 → commit**

Run: `nr check && nr test:unit && nr test:spec` → PASS

```bash
git add -A && git commit -m "feat: extend conversation batch window on typing start"
```

---

### Task 5: actor_states の記録（設計 §3.4）

**Files:**
- Modify: `src/adapters/postgres/ingestion-store.ts`（observed 記録）
- Modify: `src/adapters/postgres/effect-queue.ts`（interacted 遷移）
- Modify: `spec/adapters/postgres/ingestion-store.spec.ts`, `spec/adapters/postgres/effect-queue.spec.ts`, `spec/e2e/conversation-evaluate.spec.ts`

- [ ] **Step 1: failing tests**

`ingestion-store.spec.ts`:

```ts
it("records actors as observed on first ingest only", async () => {
  const store = new PostgresIngestionStore(sql);
  const first = canonicalEvent({ receivedAt: now });
  await store.saveEventAndSyncJob(first, { kind: "none" });
  const later = canonicalEvent({ receivedAt: new Date("2026-08-04T00:01:00Z") });
  await store.saveEventAndSyncJob(later, { kind: "none" });
  await expect(sql`select state, first_observed_at, last_interacted_at from actor_states where guild_id = 'g' and actor_id = 'u'`).resolves.toEqual([
    { state: "observed", first_observed_at: now, last_interacted_at: null },
  ]);
});
```

`effect-queue.spec.ts`（既存 fixture に decision_runs → events の連鎖があるはず。なければ events/decision_runs を含む fixture を組む）:

```ts
it("marks the trigger author as interacted when a reply effect succeeds", async () => {
  // fixture: events(actor 'u') → decision_runs(event_id) → effects(planned) → claim → succeed
  await sql`insert into actor_states (guild_id, actor_id, state, first_observed_at) values ('g', 'u', 'observed', ${now})`;
  const queue = new PostgresEffectQueue(sql);
  const effect = await queue.claim("gateway", now);
  await queue.succeed(effect!.id, "discord-reply-1", now);
  await expect(sql`select state, last_interacted_at from actor_states where guild_id = 'g' and actor_id = 'u'`).resolves.toEqual([
    { state: "interacted", last_interacted_at: now },
  ]);
});
```

Run: `nr test:spec` → 新テスト2件 FAIL を確認

- [ ] **Step 2: 実装**

`ingestion-store.ts` の `saveEventAndSyncJob` トランザクション内、イベント insert 成功直後（duplicate return より後）に追加:

```ts
await transaction`
  insert into actor_states (guild_id, actor_id, state, first_observed_at)
  values (${event.guildId}, ${event.actorId}, 'observed', ${event.receivedAt})
  on conflict (guild_id, actor_id) do nothing
`;
```

`effect-queue.ts` の `transition` メソッド、audit insert の後に追加（`succeed` と `reconcileUnknown(succeeded)` の両方が通る）:

```ts
if (state === "succeeded")
  await tx`
    update actor_states set state = 'interacted', last_interacted_at = ${now}
    where (guild_id, actor_id) in (
      select ev.guild_id, ev.actor_id
      from effects ef
      join decision_runs dr on dr.id = ef.run_id
      join events ev on ev.id = dr.event_id
      where ef.id = ${id} and ef.kind = 'discord.reply'
    )
  `;
```

（`transition` 内の変数名は既存に合わせる。`this.sql.begin(async (tx) => ...)` の `tx`。）

- [ ] **Step 3: e2e の1本目に assert を追加**

executor 成功後（`expect(await effectQueue.get(...)).toEqual(...)` の後）:

```ts
await expect(sql`select state from actor_states where guild_id = 'g' and actor_id = 'u'`).resolves.toEqual([
  { state: "interacted" },
]);
```

- [ ] **Step 4: green 確認 → commit**

Run: `nr test:spec` → PASS

```bash
git add -A && git commit -m "feat: track actor observed/interacted states"
```

---

### Task 6: staging-db-rehearsal の nix/sql 同期

migration を足したら必須（過去に #1100 で落ちた実績あり）。対象は inventory をハードコードしている資産すべて。

**Files:**
- Modify: `nix/sql/catalog-assertions.sql`, `nix/sql/runtime-acl.sql`, `nix/sql/privilege-matrix.sql`, `nix/sql/fixture.sql`, `nix/db-rehearsal.sh`

**権限の真理値表（この表が仕様。privilege-matrix.sql は既存フォーマットに合わせてこの内容を expected 行として追加・更新する）:**

| table | vicissitude_gateway | vicissitude_worker |
|---|---|---|
| jobs | SELECT, INSERT, UPDATE（SELECT/UPDATE は upsert・延長のため新規） | SELECT, UPDATE（変更なし） |
| actor_states | SELECT, INSERT, UPDATE | なし |
| conversation_cursors | なし | SELECT, INSERT, UPDATE |
| run_input_events | なし | SELECT, INSERT |

- [ ] **Step 1: runtime-acl.sql を更新**

```sql
GRANT SELECT ON schema_migrations, system_state, channel_capabilities, thread_capability_overrides, events, effects, jobs, actor_states TO vicissitude_gateway;
GRANT INSERT ON channel_capabilities, thread_capability_overrides, events, jobs, audit_entries, actor_states TO vicissitude_gateway;
GRANT UPDATE ON channel_capabilities, thread_capability_overrides, effects, jobs, actor_states TO vicissitude_gateway;
-- （DELETE 行は既存のまま）

GRANT SELECT ON schema_migrations, system_state, events, jobs, character_definitions, decision_runs, effects, conversation_cursors, run_input_events TO vicissitude_worker;
GRANT INSERT ON decision_runs, model_calls, effects, audit_entries, conversation_cursors, run_input_events TO vicissitude_worker;
GRANT UPDATE ON jobs, decision_runs, conversation_cursors TO vicissitude_worker;
```

- [ ] **Step 2: catalog-assertions.sql を更新**

- index 配列に `'jobs_scope_queued_idx'` を追加
- constraint inventory: PK `<> 11` → `<> 14`、unique `< 4` → `< 3`、FK `<> 9` → `<> 11`（jobs.event_id FK 削除、jobs.trigger_event_id + run_input_events の2本追加）。check の `< 10` はそのまま。
- audit linkage の join を新スキーマに: `JOIN jobs job ON job.trigger_event_id = event.id` に変更し、`JOIN run_input_events rie ON rie.run_id = run.id AND rie.event_id = event.id` を追加。

- [ ] **Step 3: fixture.sql を更新**

- events の insert に `thread_id` 列を追加し、event `...0008` は `'thread-staging'`、他2件は `NULL`。
- jobs の insert を置換:

```sql
INSERT INTO jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000002', 'conversation_evaluate', 'guild-staging', 'channel-staging', NULL,
   '00000000-0000-0000-0000-000000000001', 'queued',
   TIMESTAMPTZ '2026-07-25 00:00:03+00', TIMESTAMPTZ '2026-07-25 00:00:03+00',
   TIMESTAMPTZ '2026-07-25 00:00:03+00', TIMESTAMPTZ '2026-07-25 00:00:03+00'),
  ('00000000-0000-0000-0000-000000000009', 'conversation_evaluate', 'guild-staging', 'channel-staging', 'thread-staging',
   '00000000-0000-0000-0000-000000000008', 'queued',
   TIMESTAMPTZ '2026-07-25 00:00:09+00', TIMESTAMPTZ '2026-07-25 00:00:09+00',
   TIMESTAMPTZ '2026-07-25 00:00:09+00', TIMESTAMPTZ '2026-07-25 00:00:09+00');
```

（2件が同一 scope だと `jobs_scope_queued_idx` に当たるため、job 9 は thread scope に置く）
- model_calls の `purpose` を `'conversation_evaluate'` に。
- 末尾に新テーブルの fixture を追加:

```sql
INSERT INTO run_input_events (run_id, event_id)
VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001');

INSERT INTO conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at)
VALUES ('guild-staging', 'channel-staging', '', '00000000-0000-0000-0000-000000000001',
        TIMESTAMPTZ '2026-07-25 00:00:01+00', TIMESTAMPTZ '2026-07-25 00:00:04+00');

INSERT INTO actor_states (guild_id, actor_id, state, first_observed_at)
VALUES ('guild-staging', 'actor-staging', 'observed', TIMESTAMPTZ '2026-07-25 00:00:02+00');
```

- [ ] **Step 4: db-rehearsal.sh の probe を更新**

gateway positive probe:
- jobs insert を新列に:

```sql
INSERT INTO jobs (id, kind, guild_id, channel_id, thread_id, trigger_event_id, state, available_at, first_triggered_at, created_at, updated_at)
VALUES (
  '10000000-0000-0000-0000-000000000002', 'conversation_evaluate', 'gateway-probe', 'gateway-probe', NULL,
  '10000000-0000-0000-0000-000000000001', 'queued', clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp()
);
```

- 直後に追加:

```sql
SELECT id FROM jobs LIMIT 1;
UPDATE jobs SET available_at = available_at WHERE guild_id = 'gateway-probe';
INSERT INTO actor_states (guild_id, actor_id, state, first_observed_at)
VALUES ('gateway-probe', 'gateway-probe', 'observed', clock_timestamp());
UPDATE actor_states SET state = 'interacted', last_interacted_at = clock_timestamp() WHERE guild_id = 'gateway-probe';
```

worker positive probe（decision_runs probe の後に追加）:

```sql
INSERT INTO run_input_events (run_id, event_id)
VALUES ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000008');
SELECT run_id FROM run_input_events LIMIT 1;
INSERT INTO conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at)
VALUES ('guild-staging', 'channel-staging', 'worker-probe', '00000000-0000-0000-0000-000000000008', clock_timestamp(), clock_timestamp());
UPDATE conversation_cursors SET updated_at = clock_timestamp() WHERE thread_id = 'worker-probe';
SELECT last_event_id FROM conversation_cursors LIMIT 1;
```

（worker probe の model_calls `purpose` も `'conversation_evaluate'` に）

negative probes 追加:

```bash
expect_denied "$cluster" vicissitude_gateway cursor-write "INSERT INTO conversation_cursors (guild_id, channel_id, thread_id, last_event_id, last_occurred_at, updated_at) VALUES ('denied', 'denied', '', '00000000-0000-0000-0000-000000000001', clock_timestamp(), clock_timestamp())"
expect_denied "$cluster" vicissitude_gateway run-input-write "INSERT INTO run_input_events (run_id, event_id) VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001')"
expect_denied "$cluster" vicissitude_worker actor-write "UPDATE actor_states SET state = 'interacted'"
```

privilege snapshot の table 配列（line 199 付近）に `'conversation_cursors', 'run_input_events', 'actor_states'` を追加。

- [ ] **Step 5: privilege-matrix.sql を更新**

ファイルを開き、既存の expected 行のフォーマットに従って上の真理値表どおりに行を追加・更新する（gateway の jobs SELECT/UPDATE の expected を true に変えるのを忘れない）。

- [ ] **Step 6: 検証**

Run: `nr test:spec`（db-rehearsal-contract の静的表明が通ること）
Run: `nix build .#staging-db-rehearsal -L`（attr が違う場合は `nix flake show 2>/dev/null | grep -A2 rehearsal` で確認。失敗時のデバッグはログが1行しか出ない仕様なので、`nix/db-rehearsal.sh` の `exec >"$log" 2>&1` を除いたコピーを scratchpad に作り、`out`/`package`/`sql_dir` を環境変数で渡して `nix shell nixpkgs#postgresql_17 nixpkgs#jq` 下で直接実行する）
Expected: `staging-db-rehearsal: PASS`

- [ ] **Step 7: Commit**

```bash
git add nix && git commit -m "chore: sync staging db rehearsal assets with migration 0003"
```

---

### Task 7: ドキュメント整合

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-phase-2-conversation-cognition-design.md`
- Modify: `spec/corpus/conversations/05-typing-extension.json`
- Modify: `spec/corpus/README.md`（typingExtension への言及があれば）

- [ ] **Step 1: 設計書に裁定を反映**

- §3.2 末尾に追記: 「2026-08-04 裁定: typing 延長は後続イベントと同じ式 `min(now + batchWindow, first_triggered_at + maxWait)` を使う。独立した typingExtension パラメータは持たない。」
- §3.5 を書き換え: 「`batchWindow` / `maxWait` は設定値（環境変数 `VICISSITUDE_BATCH_WINDOW_MS` / `VICISSITUDE_MAX_WAIT_MS`、初期値 8秒 / 30秒）。初期値が corpus のラベルと整合することは `spec/corpus/batch-timing.spec.ts` が機械検証する。」（typingExtension の記述を削除）
- §8 の「migration 0002（Phase 2A / Thread Scope）」の 2〜5 項に「→ 実際は migration 0003 として実装（0002 は Thread Scope が使用）」の注記を入れる。

- [ ] **Step 2: corpus 05 の notes を更新**

`05-typing-extension.json` の `label.notes` の末尾2文（「この期待は…再検討する。」）を「typing 延長は §3.2 の同じ式で行う（2026-08-04 裁定済み、typingExtension パラメータは廃止）。」に置き換える。`spec/corpus/README.md` に typingExtension の記述があれば同様に更新。

- [ ] **Step 3: 検証 → commit**

Run: `nr test:spec`（corpus.spec / batch-timing.spec が通ること）

```bash
git add docs spec/corpus && git commit -m "docs: record typing-extension adjudication (same formula, no typingExtension)"
```

---

### Task 8: 仕上げ

- [ ] **Step 1: 全体検証**

Run: `nr validate`
Expected: format / lint / check / test:unit / test:spec すべて PASS

- [ ] **Step 2: 残骸チェック**

```bash
grep -rn "mention_response\|processMention\|typingExtension" src spec migrations nix docs/superpowers/specs
```

Expected: ヒットは `model-routes`（`mentionResponse` キー、意図的に維持）と設計書の履歴的記述のみ。

- [ ] **Step 3: push して PR 作成**

superpowers:finishing-a-development-branch に従う。PR タイトル例: `feat: scope-keyed conversation_evaluate job with short batch (Phase 2A)`。

---

## Self-Review メモ（作成時に確認済み）

- 設計 §3.1（scope キー化・部分 unique・trigger_event_id・延長式・observe は enqueue しない）→ Task 3a/3b/3c
- §3.2（typing、同じ式・best-effort・再起動で失われても安全側）→ Task 4
- §3.3（cursor・claim 時点境界・run_input_events・成功時のみ前進・実行中 enqueue 可能）→ Task 3e/3f、部分 unique が queued のみ対象なのは 3a の index 定義どおり
- §3.4（actor_states 記録のみ）→ Task 5
- §3.5（パラメータ設定値化 + corpus による検証）→ Task 2 / 3g
- §9（retry で同範囲再読 = cursor 非前進、重複防止 = 部分 unique、typing 喪失安全）→ 3f の cursor テストと 3c の upsert テストでカバー
- migration 同期（nix/sql）→ Task 6（メモリ `staging-db-rehearsal-broken-on-main` の全項目を反映）
- 型整合: `ConversationStore` / `ClaimedJob` / `ConversationJobDirective` の名前と形は Task 3b/3d/3e/3f で同一定義を参照
