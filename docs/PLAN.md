# PLAN.md — v2: アーキテクチャ再設計

## 1. 方針

- OpenCode SDK を AI ランタイムとして維持しつつ、周辺設計を洗練する。
- Clean Architecture の過剰な儀式（14 ポート、5 ユースケース）を廃止し、責務別フラットモジュールに移行。
- 永続化を SQLite（Drizzle ORM）に統一し、JSON/JSONL の脆弱性を解消。
- MCP サーバーを 3 プロセスに統合（core / code-exec / minecraft）。
- AgentProfile + AgentRunner でエージェント種の抽象化と将来のオーケストレーションに備える。
- ブートストラップを 1 ファイルに集約し、SIGINT/SIGTERM ハンドリングでライフサイクル管理。

## 2. 完了済みマイルストーン（旧 PLAN より引き継ぎ）

- M1: Clean Architecture 移行 ✅
- M2: 品質強化・既知バグ修正 ✅
- M3: 堅牢性強化 ✅
- M4: 機能拡張（Heartbeat、ホームチャンネル） ✅ ※プラットフォーム抽象化は将来スコープに延期
- M5: 記憶システム統合（Phase 1-3 全完了） ✅
- M6: Minecraft 拡張 ✅

## 3. ターゲットディレクトリ構成

```
src/
├── core/                    # 型定義・設定・純粋関数（外部依存なし）
│   ├── types.ts             # Branded types, 値オブジェクト, エンティティ
│   ├── config.ts            # Zod スキーマによる設定バリデーション
│   └── functions.ts         # splitMessage, evaluateDueReminders 等
│
├── agent/                   # OpenCode エージェント基盤
│   ├── profile.ts           # AgentProfile 型定義
│   ├── runner.ts            # AgentRunner（旧 PollingAgent を汎用化）
│   ├── router.ts            # GuildRouter（旧 GuildRoutingAgent）
│   ├── context-builder.ts   # システムプロンプト構築（旧 FileContextLoader）
│   ├── session-store.ts     # セッション永続化（SQLite）
│   └── profiles/            # 各エージェント種のプロファイル定義
│       └── conversation.ts  # 会話エージェント（現行の唯一のプロファイル）
│
├── gateway/                 # 外部世界との接点
│   ├── discord.ts           # DiscordGateway（簡素化）
│   └── scheduler.ts         # Heartbeat + Consolidation スケジューラ
│
├── mcp/                     # MCP サーバー（独立プロセス）
│   ├── core-server.ts       # 統合エントリポイント
│   ├── code-exec-server.ts  # コード実行（セキュリティ隔離）
│   ├── minecraft/           # Minecraft（現行維持）
│   │   └── ...
│   └── tools/               # ツール定義（register* 関数）
│       ├── discord.ts
│       ├── memory.ts
│       ├── schedule.ts
│       ├── event-buffer.ts
│       └── ltm.ts
│
├── store/                   # SQLite 統一永続化
│   ├── db.ts                # Drizzle クライアント初期化
│   ├── schema.ts            # 全テーブル定義
│   └── queries.ts           # 共通クエリヘルパー
│
├── observability/           # ログ・メトリクス
│   ├── logger.ts            # ConsoleLogger（現行踏襲）
│   └── metrics.ts           # PrometheusCollector + Server
│
├── fenghuang/               # fenghuang LTM アダプタ
├── ollama/                  # Ollama 埋め込みアダプタ
│
├── bootstrap.ts             # DI 配線 + エントリポイント（1 ファイル）
└── index.ts                 # アプリケーションエントリポイント
```

## 4. 再設計マイルストーン

### M7: 基盤層 — core/ + store/

**概要**: 型定義・設定・SQLite 永続化の土台を構築する。既存コードと並行して新モジュールを作成し、段階的に移行する。

**成果物**:

1. `core/types.ts` — Branded types（`GuildId`, `SessionKey`, `ChannelId`）と全エンティティ型を集約
2. `core/config.ts` — Zod スキーマで全環境変数をバリデーション。`loadConfig()` で `AppConfig` を返す
3. `core/functions.ts` — `splitMessage()`, `evaluateDueReminders()` を移動
4. `store/schema.ts` — Drizzle スキーマ定義（sessions, reminders, emoji_usage, event_buffer, heartbeat_config）
5. `store/db.ts` — DB 初期化（`CREATE TABLE IF NOT EXISTS` による自動作成）
6. `store/queries.ts` — 共通クエリヘルパー

**依存追加**: `drizzle-orm`, `drizzle-kit` (devDependency)

**完了条件**:

- `loadConfig()` が全環境変数をバリデーションし、不正値で起動時にエラーを出す
- SQLite DB が `data/vicissitude.db` に作成される
- 既存 JSON データからのマイグレーションスクリプトが動作する
- `nr validate` が通る
- `bun test` で core/ と store/ のテストが通る

**チーム割り当て**:

| エージェント | 担当                                                   | 備考                                   |
| ------------ | ------------------------------------------------------ | -------------------------------------- |
| agent-core   | `core/types.ts`, `core/config.ts`, `core/functions.ts` | 既存 domain/ から型と関数を移動・統合  |
| agent-store  | `store/` 全体 + Drizzle 設定                           | スキーマ定義、マイグレーション、クエリ |

---

### M8: MCP サーバー統合

**概要**: 5 つの MCP サーバー（discord, memory, schedule, event-buffer, ltm）を 1 つの `core-server` に統合する。ツール定義を `mcp/tools/` に分離し、将来の再分割に備える。

**成果物**:

1. `mcp/tools/discord.ts` — `registerDiscordTools(server, deps)` 関数
2. `mcp/tools/memory.ts` — `registerMemoryTools(server, deps)` 関数
3. `mcp/tools/schedule.ts` — `registerScheduleTools(server, deps)` 関数
4. `mcp/tools/event-buffer.ts` — `registerEventBufferTools(server, deps)` 関数（SQLite ベース）
5. `mcp/tools/ltm.ts` — `registerLtmTools(server, deps)` 関数
6. `mcp/core-server.ts` — 全ツールを組み立てる統合エントリポイント
7. event-buffer を SQLite ベースに移行（JSONL 廃止）

**前提**: M7 の store/ が完成していること

**完了条件**:

- `core-server.ts` が単一プロセスで全ツールを提供する
- `code-exec-server.ts` は変更なし（独立維持）
- `minecraft/` は変更なし（独立維持）
- OpenCode から全ツールが呼べることを手動確認
- 既存の JSONL イベントバッファが SQLite に置き換わっている
- `nr validate` が通る

**チーム割り当て**:

| エージェント      | 担当                                                                       | 備考                                            |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| agent-mcp-discord | `mcp/tools/discord.ts`                                                     | 既存 discord-server.ts からツール定義を抽出     |
| agent-mcp-memory  | `mcp/tools/memory.ts`, `mcp/tools/ltm.ts`                                  | 既存 memory-server.ts + ltm-server.ts を統合    |
| agent-mcp-infra   | `mcp/tools/schedule.ts`, `mcp/tools/event-buffer.ts`, `mcp/core-server.ts` | 統合サーバーの組み立て + event-buffer SQLite 化 |

---

### M9: エージェント抽象化

**概要**: `PollingAgent` を `AgentProfile` + `AgentRunner` に分解し、エージェント種の追加を容易にする。

**成果物**:

1. `agent/profile.ts` — `AgentProfile` 型定義（name, buildSystemPrompt, mcpServers, builtinTools, pollingPrompt, model）
2. `agent/runner.ts` — `AgentRunner` クラス（旧 PollingAgent から profile 固有ロジックを除去し汎用化）
3. `agent/router.ts` — `GuildRouter`（旧 GuildRoutingAgent）
4. `agent/context-builder.ts` — `ContextBuilder`（旧 FileContextLoader + Factory を統合、LTM ファクト注入を SQLite 化）
5. `agent/session-store.ts` — セッション永続化を SQLite に移行
6. `agent/profiles/conversation.ts` — 現行の会話エージェントプロファイル

**前提**: M7（store/）が完成していること。M8 と並行可能。

**完了条件**:

- `AgentRunner` が任意の `AgentProfile` を受け取って動作する
- 会話エージェントが `profiles/conversation.ts` のプロファイルで現行と同じ動作をする
- セッション永続化が `data/sessions.json` → SQLite に移行済み
- `nr validate` が通る

**チーム割り当て**:

| エージェント     | 担当                                                                                   | 備考                              |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| agent-agent-core | `agent/profile.ts`, `agent/runner.ts`, `agent/router.ts`                               | PollingAgent のリファクタリング   |
| agent-agent-ctx  | `agent/context-builder.ts`, `agent/session-store.ts`, `agent/profiles/conversation.ts` | コンテキスト構築 + セッション移行 |

---

### M10: ブートストラップ + ゲートウェイ簡素化

**概要**: 4 ファイルのブートストラップを 1 ファイルに統合。DiscordGateway とスケジューラを gateway/ に移動。SIGINT/SIGTERM ハンドリングで graceful shutdown。

**成果物**:

1. `bootstrap.ts` — 1 ファイルの DI 配線 + エントリポイント
2. `gateway/discord.ts` — DiscordGateway（簡素化、イベントルーティングを直接記述）
3. `gateway/scheduler.ts` — Heartbeat + Consolidation スケジューラを統合
4. `observability/logger.ts` — ConsoleLogger 移動
5. `observability/metrics.ts` — PrometheusCollector + Server 移動
6. SIGINT/SIGTERM ハンドリングで graceful shutdown

**前提**: M8, M9 が完成していること

**完了条件**:

- `bootstrap.ts` が唯一の DI 配線ファイル
- `composition-root.ts`, `bootstrap-context.ts`, `bootstrap-helpers.ts`, `bootstrap-agents.ts` を削除
- 旧 `domain/`, `application/`, `infrastructure/` ディレクトリを完全削除
- graceful shutdown が SIGINT/SIGTERM ハンドリングで動作
- `nr validate` が通る
- `bun test` が通る
- 手動動作確認（Discord 応答、Heartbeat、Minecraft）

**チーム割り当て**:

| エージェント        | 担当                                                  | 備考                           |
| ------------------- | ----------------------------------------------------- | ------------------------------ |
| agent-bootstrap     | `bootstrap.ts`, shutdown ロジック                     | 全配線の統合                   |
| agent-gateway       | `gateway/discord.ts`, `gateway/scheduler.ts`          | ゲートウェイ移動 + 簡素化      |
| agent-observability | `observability/logger.ts`, `observability/metrics.ts` | 移動のみ、ロジック変更は最小限 |

---

### M11: クリーンアップ + ドキュメント更新

**概要**: 旧コードの完全削除、ドキュメント更新、最終検証。

**成果物**:

1. 旧 MCP サーバー（`discord-server.ts`, `memory-server.ts`, `schedule-server.ts`, `event-buffer-server.ts`, `ltm-server.ts`）の削除
2. `docs/ARCHITECTURE.md` の全面更新
3. `docs/STATUS.md` の更新
4. `docs/RUNBOOK.md` の更新（新コマンド体系に合わせて）
5. `docs/SPEC.md` の更新（新アーキテクチャに合わせて）
6. `CLAUDE.md` の更新

**完了条件**:

- `src/` 配下にターゲット構成以外のファイルがない
- 全ドキュメントが新アーキテクチャを反映している
- `nr validate` が通る
- `bun test` が通る
- デプロイして本番動作確認

## 5. マイルストーン依存グラフ

```
M7 (core/ + store/)
├──→ M8 (MCP 統合)──────→ M10 (bootstrap + gateway)──→ M11 (cleanup)
└──→ M9 (agent 抽象化)──→ M10
```

- M8 と M9 は M7 完了後に並行着手可能
- M10 は M8, M9 の両方が完了してから着手
- M11 は M10 完了後

## 6. チーム構成（Agent Team）

各マイルストーンで以下のチーム構成を使用する:

### リーダー: team-lead

- タスクの分割・割り当て
- マイルストーン境界での統合テスト
- コンフリクト解決

### ワーカーエージェント（マイルストーンごとに spawn/shutdown）

**M7**:

- `agent-core`: core/ 全般（型、設定、純粋関数）
- `agent-store`: store/ 全般（Drizzle スキーマ、DB、マイグレーション）

**M8**:

- `agent-mcp-discord`: Discord ツール抽出
- `agent-mcp-memory`: Memory + LTM ツール統合
- `agent-mcp-infra`: Schedule + EventBuffer + core-server 統合

**M9**:

- `agent-agent-core`: AgentProfile / Runner / Router
- `agent-agent-ctx`: ContextBuilder / SessionStore / Profiles

**M10**:

- `agent-bootstrap`: bootstrap.ts + shutdown
- `agent-gateway`: discord.ts + scheduler.ts
- `agent-observability`: logger.ts + metrics.ts

**M11**:

- `agent-cleanup`: 旧コード削除 + ドキュメント更新（1 エージェントで十分）

## 7. リスクレジスタ

| ID  | リスク                                    | 影響                 | 対策                                                                                    |
| --- | ----------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| R1  | SQLite マイグレーション中のデータロス     | 記憶・セッション消失 | JSON → SQLite のマイグレーションスクリプトを先に作成・テスト                            |
| R2  | MCP 統合で OpenCode との接続不良          | bot 停止             | 段階的に統合（まず 2 サーバーを統合して検証、残りを追加）                               |
| R3  | Drizzle ORM の Bun 互換性問題             | ビルド不可           | `better-sqlite3` ドライバで事前検証。問題があれば `bun:sqlite` 直接使用にフォールバック |
| R4  | event-buffer の SQLite 化でポーリング遅延 | 応答遅延             | SQLite WAL モード + NOTIFY 相当の仕組み（fs.watch or polling）で即時性を維持            |
| R5  | 大規模リファクタリング中の本番不安定      | サービス停止         | 各マイルストーン完了時にデプロイ・検証。問題があれば旧コードに revert 可能な状態を維持  |
| R6  | fenghuang ライブラリの SQLite 統合        | LTM 機能後退         | fenghuang は現行の独立 SQLite を維持し、core DB とは別管理とする選択肢を残す            |

## 8. 完了定義（DoD）

- `nr validate` が通る
- `bun test` が通る
- ドキュメント（ARCHITECTURE.md, STATUS.md）が現在の実装と一致する
- 手動動作確認: Discord 応答、Heartbeat 自律行動、Minecraft 接続（MC_HOST 設定時）
- 旧ディレクトリ・旧ファイルが `src/` に残っていない
- PR は各マイルストーン単位でマージする

## 9. 設計判断の根拠（ADR 的メモ）

### なぜポート層を廃止するか

- 14 ポート中、テストでモック差し替えされるのは 2-3 個
- 実装が 1 つしかないインターフェースは **Speculative Generality**（YAGNI 違反）
- テスト時に差し替えが必要な箇所は、コンストラクタ引数に関数を渡せばよい

### なぜユースケース層を廃止するか

- `BufferEventUseCase` は `eventBuffer.append()` を呼ぶだけ
- `RecordConversationUseCase` は `recorder.record()` を呼ぶだけ
- 1 行の委譲をクラスにしても、テスタビリティも可読性も向上しない

### なぜ Effect-TS を採用しないか

- 学習コストが高く、コントリビューターの参入障壁になる
- このプロジェクトの規模では Result 型 + AbortController で十分
- OpenCode SDK 自体が Promise ベースなので、Effect との相性に懸念

### なぜ Markdown メモリは SQLite 化しないか

- AI が MCP ツールで直接読み書きする形式として Markdown が最適
- SQLite に入れると SQL → Markdown 変換が必要になり、かえって複雑化
- context/ のオーバーレイパターンは十分に機能している

### なぜ fenghuang を内製化しないか（R6 関連）

- fenghuang の Episode/SemanticFact モデルと FSRS スケジューリングは十分に機能している
- 内製化のコストに見合う改善点が現時点では不明確
- 独立 SQLite のまま運用し、将来必要なら統合を検討する
