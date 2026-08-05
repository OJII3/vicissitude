# Phase 2: Conversation Cognition 設計

日付: 2026-07-29
前提: [2026-07-23 アーキテクチャ設計](2026-07-23-ai-character-platform-architecture-design.md)、Phase 1 durable spine（migration 0001）

## 1. 目的と分割

Phase 1 は「明示 mention 1件を読み、モデルを1回呼び、600文字以内の reply effect を作る」直線的な処理である。Phase 2 はこれを会話単位の認知へ拡張する。一括実装は行わず、失敗原因を切り分けられるよう3段階に分割する。

- **Phase 2A: Durable Conversation Assembly** — モデル判断を増やさず、会話入力を正しく組み立てる。Thread Scope の導入を先頭スライスとする
- **Phase 2B: Typed Cognition Pipeline** — メッセージから直接文章を生成する処理を、型付きの監査可能な段階に分ける
- **Phase 2C: Discord Actions and Conversation UX** — 行動種別と会話体験を広げる

Scenario corpus は Phase 2A と並行して整備し、batch パラメータと宛先推定品質の判断基準にする。

## 2. Thread Scope（Phase 2A 先頭スライス）

### 2.1 背景

Canonical event は既に `channelId`（親チャンネル）と `threadId` を分離して保持し、effect も `capability_channel_id`（認可用）と `target_channel_id`（送信先）を区別している。欠けているのは capability の粒度と会話 scope の定義の2点であり、スレッド主体で運用するギルド（特にフォーラムチャンネル）では `observe_events` を有効にした瞬間に配下の全スレッドが観察対象になってしまう。

### 2.2 Capability 解決モデル

`channel_capabilities` を「親チャンネルのデフォルト」として維持し、スレッド単位の override テーブルを追加する。

```sql
CREATE TABLE thread_capability_overrides (
  guild_id text NOT NULL,
  channel_id text NOT NULL,   -- 親チャンネル
  thread_id text NOT NULL,
  observe_events boolean,      -- NULL = 親を継承
  respond_to_mentions boolean, -- NULL = 親を継承
  add_reactions boolean,       -- NULL = 親を継承
  updated_at timestamptz NOT NULL, updated_by text NOT NULL, reason text NOT NULL,
  PRIMARY KEY (guild_id, channel_id, thread_id)
);
```

- 各 capability カラムは nullable boolean。`NULL` は親チャンネル値の継承、`true` / `false` は明示 override。許可側 override（親 deny + スレッド allow）と拒否側 override（親 allow + スレッド deny）の両方を表現できる
- override 対象はスレッド内で意味を持つ capability のみ（`observe_events` / `respond_to_mentions` / `add_reactions`）。`create_threads` や `share_files` 等はチャンネルレベルのまま。必要になった時点でカラムを追加する
- 解決はドメイン層の純関数 `resolveEffectiveCapabilities(channel, threadOverride | null)` で行う。ingest 時（gateway）と effect 実行時（worker）の両方が同じ関数を通る。effect worker は `target_channel_id` がスレッドの場合、`capability_channel_id` のチャンネル capability に加えて thread override を参照する

### 2.3 管理コマンド

既存の `/channel` コマンドに thread 用 subcommand を追加する（例: `/channel thread-set thread:<id> capability:<name> value:<allow|deny|inherit>`）。`inherit` は該当カラムを NULL に戻し、全 capability カラムが NULL になった row は削除する。監査列（`updated_by` / `reason`）は既存規約に従う。

### 2.4 Conversation scope キー

Phase 2A の `conversation_evaluate` job が読む会話 scope を次で定義する。

```text
ConversationScope = (guildId, channelId, threadId | null)
```

- `threadId` を持つスレッドはそれ自体が独立した会話 scope であり、親チャンネルの会話と混ざらない
- スレッドは cluster 推定の「強い証拠」（アーキテクチャ設計 7.3）から「決定的な境界」に格上げする。7.3 の cluster 推定は同一 scope 内の並行会話分離にのみ適用する
- `events` に `(guild_id, channel_id, thread_id, occurred_at DESC)` の index を追加する

### 2.5 やらないこと

- フォーラムチャンネルの「新規スレッド自動方針」（threadDefault 項目）— 継承モデルにおいて channel 側 `observe_events=false` がその役割を果たす
- スレッドのアーカイブ状態の追跡 — Phase 2C の自発投稿まで不要

## 3. Phase 2A: Durable Conversation Assembly

### 3.1 Job のスコープキー化

Phase 1 の `mention_response` job（イベント1件 = job 1件、即時実行）を、`conversation_evaluate` job（会話 scope 1つ = 待機中 job 最大1件）に置き換える。後方互換パスは作らない。

- `jobs` に scope 列（`guild_id`, `channel_id`, `thread_id`）と `first_triggered_at` を追加し、部分 unique index `UNIQUE (kind, guild_id, channel_id, thread_id) WHERE state = 'queued'` で「同一 scope の待機 job は常に1件」を保証する（`thread_id` は `COALESCE(thread_id, '')` で正規化した式 index とする）
- `event_id` は nullable な `trigger_event_id`（初回トリガーイベント参照）に置き換える
- ingest 時の動作:
  - トリガー条件（Phase 2A では明示 mention のみ。`respond_to_mentions` の effective capability で判定）を満たすイベントが来たら、scope の queued job を upsert する。新規なら `available_at = now + batchWindow`、`first_triggered_at = now`
  - すでに queued job がある scope に後続イベントが来たら（mention でなくてもよい）、`available_at = min(now + batchWindow, first_triggered_at + maxWait)` に延長する。これが short batch の実体
  - observe のみのイベントは job を新規作成しない（保存と batch 参加のみ。賢い会話判定は 2B）

インメモリタイマーは使わない。待機はすべて `available_at` として DB に永続化され、Gateway / worker の再起動で batch は失われない。

### 3.2 Typing 延長

Gateway が `typingStart` を受けたら、該当 scope の queued job の `available_at` を同じ式（maxWait 上限つき）で延長する UPDATE を発行する。best-effort であり、再起動で typing 延長が失われても job が少し早く発火するだけで安全側に倒れる。

2026-08-04 裁定: typing 延長は後続イベントと同じ式 `min(now + batchWindow, first_triggered_at + maxWait)` を使う。独立した typingExtension パラメータは持たない。

### 3.3 Batch の読み出しと cursor

- 新テーブル `conversation_cursors`（PK = scope、`last_event_id` / `last_occurred_at`）を追加する
- Worker は job を claim したら、cursor 以降・claim 時点までの canonical event を scope から読み出す
- run の処理成功時に cursor を前進させる。失敗時は前進させず、retry が同じ範囲を再読する
- run が読んだイベント集合は `run_input_events (run_id, event_id)` join テーブルに記録し、「この応答はどのメッセージ群を見たか」を監査可能にする
- run 実行中に到着したイベントは claim 時点より後なので読み出し範囲に含まれず、次の job（部分 unique は queued のみ対象のため実行中でも新規 enqueue できる）が cursor 経由で拾う。取りこぼしと二重読みの両方が起きない

認知そのものは Phase 1 と同じ（mention への 600 文字以内 reply）だが、入力が単一イベントから batch に変わる。

既知の制限: 並行 ingest の commit 順逆転で cursor が先行 job の batch に取り込まれた mention を追い越した場合、その mention の job は trigger のみを含む batch で応答する（loadBatch が trigger を無条件に含めるため黙殺はしない。trigger は必ず batch に含まれる）。ただし周辺文脈が欠落した返信になりうる。

### 3.4 Actor 状態

新テーブル `actor_states (guild_id, actor_id, state, first_observed_at, last_interacted_at)` を追加する。

- row なし = `unseen`
- 初回 ingest で `observed`
- そのユーザーのメッセージへの reply effect が成功したら `interacted`

Phase 2A では記録のみで判断に使わない。2B の宛先推定の入力になる。

### 3.5 パラメータ

`batchWindow` / `maxWait` は設定値（環境変数 `VICISSITUDE_BATCH_WINDOW_MS` / `VICISSITUDE_MAX_WAIT_MS`、初期値 8秒 / 30秒）。初期値が corpus のラベルと整合することは `spec/corpus/batch-timing.spec.ts` が機械検証する。

## 4. Phase 2B: Typed Cognition Pipeline

### 4.1 段階分割

```text
ConversationContext → AddresseeInference → ActionDecision → SpeechGeneration → Effect planning
```

`ActionDecision` は次の3種に限定する。`reaction` と新規 `post` は 2C に回す。

```ts
type ConversationAction =
  | { type: "silence"; reasonCode: string }
  | { type: "reply"; targetMessageId: string }
  | { type: "defer"; resumeAt: Date; reasonCode: string };
```

### 4.2 記録と監査

- 各段階の出力は既存の `audit_entries`（`summary jsonb` + run 参照）に category 付きで記録する（例: `cognition.addressee`、`cognition.action`）。新テーブルは作らない
- `decision_runs.action_kind` の CHECK を `('reply')` から `('reply', 'silence', 'defer')` に拡張する。`silence` も run として記録し、`reason_codes` に理由を残す
- これにより「宛先推定は正しかったが生成に失敗した」「宛先推定自体が間違っていた」「意図的に沈黙した」「後で回答することを選んだ」を区別して監査できる

### 4.3 トリガーの拡張

宛先推定が意味を持つのは非 mention イベントが評価対象になるときなので、observed イベントからの job 生成は 2B で解禁する。全メッセージでモデルを回さないよう二段構えにする。

1. ingest 時: 決定的な安価トリガー（名前呼びパターン、bot 宛 reply、直近で bot が発話した scope）を通過したものだけ `conversation_evaluate` を enqueue
2. worker 側: AddresseeInference が最終判断し、宛先でなければ `silence` として記録

### 4.4 defer

新種の job は作らず、同一 scope の `conversation_evaluate` job を `available_at = resumeAt` で再 enqueue し、`reason_codes` に defer 理由を記録する。Phase 2A の仕組みをそのまま使う。

## 5. Phase 2C: Discord Actions and Conversation UX

- effect kind を `discord.reply` から `discord.reaction` / `discord.post`（非 reply 投稿）/ typing 表示へ拡張する。effect ledger の構造と認可フロー（channel capability + thread override）は変更しない
- Gateway だけが Discord token を持つ境界を維持する。cognition worker は effect を永続化するのみ
- 発話量制御・詳細確認を返す判断・不確実性の表現は SpeechGeneration 段の入力（ConversationPolicy）として実装する
- `defer` の継続 job、必要に応じた一次反応、最終回答の分割もこの段階で扱う

## 6. Scenario Corpus（Phase 2A と並行）

- 置き場所: `spec/corpus/conversations/*.json`。1ファイル = 1 scenario
- 各 scenario はイベント列（相対タイミング付き）と人手ラベルを持つ
  - 宛先
  - 期待 action（reply / silence / defer）
  - 参照すべきメッセージ
  - 許容最大待機時間
  - 誤介入の重大度

初期セットは次の10ケース。

| Scenario | 期待結果 |
|---|---|
| キャラクターへの明示 mention | reply |
| 他人への reply 内にキャラクター名が出る | silence |
| 「ふあはどう思う？」のような名前呼び | reply |
| 複数人の連投中に明示 mention | batch 後に reply |
| typing 中に追加メッセージが来る | 追加分を同じ batch に含める |
| thread 内の会話 | thread を scope 境界にする |
| 同じ channel で2会話が並行 | 誤った会話へ介入しない |
| 質問が途中で分割投稿される | 最後まで待って reply |
| 回答に追加情報が必要 | 詳細確認 |
| キャラクターに向けられていない雑談 | silence |

初期は人手評価のみとし、LLM 品質の数値化はしない。`spec/e2e/` ハーネスへの自動実行接続は 2B 以降に判断する。

## 7. ConversationPolicy（CharacterDefinition への最小追加）

`character_definitions.definition` (jsonb) に次の数値契約のみを追加する。既存のバージョニング（version + production unique index）に乗るためスキーマ変更は不要。

```ts
interface ConversationPolicy {
  mentionResponsePriority: number;
  implicitAddressThreshold: number;
  interruptionAversion: number;
  defaultUtteranceBudget: number;
  clarificationPreference: number;
  silenceBias: number;
}
```

感情・relationship・interest は Phase 3 との境界を壊さないため入れない。

## 8. DB 変更まとめ

**migration 0002（Phase 2A / Thread Scope）**

1. `thread_capability_overrides` テーブル追加（2.2）
2. `jobs`: kind を `conversation_evaluate` に変更、scope 列 + `first_triggered_at` 追加、`event_id` → nullable `trigger_event_id`、`UNIQUE (kind, event_id)` を部分 unique index に置換（3.1）
3. `conversation_cursors` テーブル追加（3.3）
4. `run_input_events` テーブル追加（3.3）
5. `actor_states` テーブル追加（3.4）
6. `events` に `(guild_id, channel_id, thread_id, occurred_at DESC)` index 追加（2.4）

（注: 項目2〜5は実際は migration 0003 として実装した。0002 は Thread Scope が使用する）

**migration 0003（Phase 2B）**

- `decision_runs.action_kind` CHECK 拡張: `('reply', 'silence', 'defer')`

**migration 0004（Phase 2C）**

- `effects.kind` CHECK 拡張: `('discord.reply', 'discord.reaction', 'discord.post')` ほか

本番運用前のため、既存データの移行パスは最小限とする。

## 9. Failure Handling

- **batch job の失敗**: 既存の lease / max_attempts (3) / retry 機構をそのまま使う。cursor は成功時のみ前進するため、失敗した run のイベントは retry で再読され、取りこぼさない
- **typing 延長の喪失**: 再起動で失われても job が早く発火するだけで安全
- **重複防止**: 部分 unique index（queued のみ）により待機 job は scope あたり1件。実行中の新着イベントは次の job が cursor 経由で処理する
- **effect 実行時の capability 変更**: Phase 1 同様、effect 実行直前に effective capability（thread override 込み）を再評価する
- **defer job の失敗**: 通常の retry に従う

## 10. 実装順序

1. **Phase 2A**: Thread Scope（migration + 解決関数 + `/channel` 拡張）→ scope キー job + batch + cursor → typing 延長 → actor 状態。並行して scenario corpus 初期10ケース作成
2. **Phase 2B**: 型付き段階 + audit 記録 → observed トリガー解禁 → defer
3. **Phase 2C**: effect 種別拡張 → 会話 UX

各 Phase の実装計画は writing-plans で個別に作成する。
