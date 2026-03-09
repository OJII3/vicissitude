# ARCHITECTURE.md

## 1. 位置づけ

- 本書は、現在の実装構成（`src/` 配下モジュール構成）に基づく実装準拠アーキテクチャを定義する。
- Minecraft 拡張は「既存構成を維持した段階的追加」として、末尾の拡張設計セクションに記載する。
- 要件の正本は `SPEC.md`、運用方針の正本は `RUNBOOK.md`、進行状況の正本は `STATUS.md` とする。

## 2. 設計原則

- KISS: 小さい責務を明確な境界で分割する。
- YAGNI: 現行要件に不要な機能は導入しない。
- 責務別フラットモジュール構成を採用する（Clean Architecture からの移行完了）。
- 手動コンストラクタ注入（Pure DI）のみ使用し、DI コンテナは導入しない。

## 3. システム境界

- 本体コード: `vicissitude` リポジトリ (`src/`)
- コンテキスト: `context/`（git 管理・ベース）+ `data/context/`（gitignore・オーバーレイ、読み込み優先）
- データ: `data/` ディレクトリ（`vicissitude.db`（SQLite: sessions, reminders, event_buffer, emoji_usage, heartbeat_config）、`fenghuang/guilds/{guildId}/memory.db`、`context/`）
- 外部依存:
  - Discord API (`discord.js`)
  - OpenCode SDK (`@opencode-ai/sdk`)
  - MCP SDK (`@modelcontextprotocol/sdk`)
  - Drizzle ORM (`drizzle-orm`) + `bun:sqlite`
  - fenghuang（LTM: Episode/SemanticFact 管理）
  - mineflayer + mineflayer-pathfinder（Minecraft 操作、`MC_HOST` 設定時のみ）

## 4. モジュール構成

```
src/
├── core/                    # 型定義・設定・純粋関数（外部依存なし）
│   ├── types.ts             # 型定義、値オブジェクト、インターフェース
│   ├── config.ts            # Zod スキーマによる設定バリデーション
│   └── functions.ts         # splitMessage, evaluateDueReminders 等
│
├── agent/                   # OpenCode エージェント基盤
│   ├── profile.ts           # AgentProfile 型定義
│   ├── runner.ts            # AgentRunner（ポーリングループ）
│   ├── router.ts            # GuildRouter（ギルド ID ベースのルーティング）
│   ├── context-builder.ts   # システムプロンプト構築（LTM ファクト注入含む）
│   ├── session-store.ts     # セッション永続化（SQLite）
│   ├── mcp-config.ts        # MCP サーバー設定（core / code-exec / minecraft）
│   └── profiles/
│       └── conversation.ts  # 会話エージェントプロファイル
│
├── gateway/                 # 外部世界との接点
│   ├── discord.ts           # DiscordGateway
│   ├── discord-attachment-mapper.ts  # 添付ファイルマッピング
│   ├── message-handlers.ts  # bufferIncomingMessage + recordLtmMessage
│   └── scheduler.ts         # HeartbeatScheduler + ConsolidationScheduler
│
├── mcp/                     # MCP サーバー（独立プロセス、レイヤー外）
│   ├── core-server.ts       # 統合エントリポイント（discord + memory + schedule + event-buffer + ltm）
│   ├── code-exec-server.ts  # コード実行（Podman サンドボックス）
│   ├── memory-helpers.ts    # メモリツール用ヘルパー関数
│   ├── minecraft/           # Minecraft（StreamableHTTP、MC_HOST 設定時のみ）
│   │   └── ...
│   └── tools/               # ツール定義（registerXxxTools 関数）
│       ├── discord.ts
│       ├── memory.ts
│       ├── schedule.ts
│       ├── event-buffer.ts
│       └── ltm.ts
│
├── store/                   # SQLite 統一永続化（Drizzle ORM）
│   ├── db.ts                # Drizzle クライアント初期化
│   ├── schema.ts            # 全テーブル定義
│   └── queries.ts           # 共通クエリヘルパー
│
├── observability/           # ログ・メトリクス
│   ├── logger.ts            # ConsoleLogger（NDJSON 構造化ログ）
│   └── metrics.ts           # PrometheusCollector + Server + InstrumentedAiAgent
│
├── fenghuang/               # fenghuang LTM アダプタ
│   ├── composite-llm-adapter.ts       # CompositeLLMAdapter（chat + embed の合成）
│   ├── fenghuang-chat-adapter.ts      # FenghuangChatAdapter（OpenCode SDK 経由）
│   ├── fenghuang-conversation-recorder.ts  # FenghuangConversationRecorder（会話記録 + 統合）
│   └── fenghuang-fact-reader.ts       # FenghuangFactReader（SQLite 読み取り専用）
│
├── ollama/                  # Ollama 埋め込みアダプタ
│   └── ollama-embedding-adapter.ts    # OllamaEmbeddingAdapter（HTTP API）
│
├── bootstrap.ts             # DI 配線エントリポイント
└── index.ts                 # アプリケーションエントリポイント
```

### 4.1 core/ — 型・設定・純粋関数

- `types.ts`: 全エンティティ型、インターフェース（`ConversationRecorder`, `MemoryConsolidator`, `LtmFactReader` 等）
- `config.ts`: Zod スキーマで全環境変数をバリデーション。`loadConfig()` で `AppConfig` を返す
- `functions.ts`: `splitMessage()`, `evaluateDueReminders()` 等の純粋関数

### 4.2 agent/ — OpenCode エージェント基盤

- `profile.ts`: `AgentProfile` 型定義（name, mcpServers, builtinTools, model 等）
- `runner.ts`: `AgentRunner` — `AgentProfile` を受け取って `promptAsync()` でポーリングループを実行。セッション自動ローテーション（`SESSION_MAX_AGE_HOURS`、デフォルト 48 時間）を内蔵
- `router.ts`: `GuildRouter` — ギルド ID に基づいて適切なギルド固有エージェントにルーティングするファサード。`guildId` 未指定時は `defaultAgent` にフォールバック
- `context-builder.ts`: `ContextBuilder` — オーバーレイ方式でコンテキストファイルを読み込み、LTM ファクトを注入してシステムプロンプトを構築
- `session-store.ts`: `SessionStore` — SQLite でセッション ID を永続化
- `mcp-config.ts`: `mcpServerConfigs()` — MCP サーバー設定を返す。`core`（統合サーバー）、`code-exec`、`minecraft`（条件付き）の 3 エントリ
- `profiles/conversation.ts`: 会話エージェントプロファイル

### 4.3 gateway/ — 外部世界との接点

- `discord.ts`: `DiscordGateway` — discord.js Client でメッセージ受信。ルーティング: メンション/スレッド -> onMessage、ホームチャンネル -> onHomeChannelMessage。`onEmojiUsed()` でカスタム絵文字トラッキング
- `message-handlers.ts`: `bufferIncomingMessage()` — 受信メッセージをイベントバッファに追加。`recordLtmMessage()` — LTM に会話を記録
- `scheduler.ts`: `HeartbeatScheduler`（1 分間隔）+ `ConsolidationScheduler`（30 分間隔、初回 5 分遅延）

### 4.4 mcp/ — MCP サーバー（独立プロセス）

MCP サーバーは 3 プロセス構成:

1. **core-server.ts** (`type: "local"`): Discord 操作 + メモリ管理 + スケジュール管理 + イベントバッファ + LTM を統合した単一プロセス
   - `tools/discord.ts`: `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`, `list_channels`
   - `tools/memory.ts`: `read_memory`, `update_memory`, `read_soul`, `append_daily_log`, `read_daily_log`, `list_daily_logs`, `read_lessons`, `update_lessons`
   - `tools/schedule.ts`: `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
   - `tools/event-buffer.ts`: `wait_for_events` — SQLite ベース
   - `tools/ltm.ts`: `ltm_retrieve`, `ltm_consolidate`, `ltm_get_facts`
2. **code-exec-server.ts** (`type: "local"`): `execute_code` — Podman コンテナでサンドボックス実行
3. **minecraft/server.ts** (`type: "remote"`、`MC_HOST` 設定時のみ): StreamableHTTP サーバー
   - `observe_state`, `get_recent_events`, `follow_player`, `go_to`, `collect_block`, `stop`, `get_job_status`, `get_viewer_url`, `craft_item`, `place_block`, `equip_item`, `sleep_in_bed`, `send_chat`

### 4.5 store/ — SQLite 統一永続化

- `db.ts`: Drizzle クライアント初期化（`bun:sqlite`）
- `schema.ts`: テーブル定義（sessions, reminders, event_buffer, emoji_usage, heartbeat_config）
- `queries.ts`: 共通クエリヘルパー（`appendEvent`, `hasEvents`, `consumeEvents`, `incrementEmoji` 等）

### 4.6 observability/ — ログ・メトリクス

- `logger.ts`: `ConsoleLogger` — JSON 構造化ログ（NDJSON）を stdout/stderr に出力
- `metrics.ts`: `PrometheusCollector` + `PrometheusServer` + `InstrumentedAiAgent` + `METRIC` 定数

### 4.7 fenghuang/ — LTM アダプタ

- `composite-llm-adapter.ts`: `CompositeLLMAdapter implements LLMPort` — chat を `FenghuangChatAdapter`、embed を `OllamaEmbeddingAdapter` に委譲
- `fenghuang-chat-adapter.ts`: `FenghuangChatAdapter` — OpenCode SDK を使って fenghuang の LLMPort 用 chat/chatStructured を提供
- `fenghuang-conversation-recorder.ts`: `FenghuangConversationRecorder` — Guild ごとの会話記録 + メモリ統合。`ConversationRecorder` + `MemoryConsolidator` インターフェースを実装
- `fenghuang-fact-reader.ts`: `FenghuangFactReader` — Guild ごとの SQLite DB から SemanticFact を読み取り専用で取得。WAL モードで安全に同時アクセス

### 4.8 ollama/ — 埋め込みアダプタ

- `ollama-embedding-adapter.ts`: `OllamaEmbeddingAdapter` — Ollama HTTP API でテキスト埋め込みベクトルを取得（30 秒タイムアウト）

### 4.9 bootstrap.ts — DI 配線

- `bootstrap()` — DI 配線のエントリポイント
- 全モジュールをインスタンス化し、イベントハンドラをバインド
- ギルドごとに `AgentRunner` + `SqliteEventBuffer` を生成し、`GuildRouter` でラップ
- LTM 記録、Heartbeat スケジューラ、Consolidation スケジューラを起動
- Minecraft MCP を子プロセスとして起動（`MC_HOST` 設定時のみ）
- Graceful shutdown（SIGINT/SIGTERM）実装済み

### 4.10 OpenCode 組み込みツール

`AgentRunner` では以下の OpenCode SDK 組み込みツールを有効化している:

- `webfetch`: 指定 URL の内容を取得
- `websearch`: Web 検索を実行

その他の組み込みツール（`read`, `edit`, `write`, `bash`, `glob`, `grep`, `task`, `question`, `todowrite`, `skill`）は無効化している。

## 5. データモデル

### AgentResponse

- `text: string`
- `sessionId: string`

### SessionKey

- ユーザー単位: `{platform}:{channelId}:{authorId}` (例: `discord:123456:789012`)
- チャンネル単位: `{platform}:{channelId}:_channel` (例: `discord:123456:_channel`)

### Attachment

- `url: string` — 添付ファイルの URL
- `contentType?: string` — MIME タイプ
- `filename?: string` — ファイル名

### IncomingMessage

- `platform: string` — プラットフォーム識別子
- `channelId: string`
- `guildId?: string` — Guild ID（DM 時は undefined）
- `authorId: string`
- `authorName: string`
- `messageId: string`
- `content: string`
- `attachments: Attachment[]` — 画像添付ファイル一覧
- `timestamp: Date` — メッセージ作成時刻
- `isMentioned: boolean`
- `isThread: boolean`
- `isBot: boolean` — 送信者が Bot かどうか
- `reply(text: string): Promise<void>`
- `react(emoji: string): Promise<void>`

### channels.json 構造

```json
{
	"defaultCooldownSeconds": 120,
	"channels": [
		{
			"channelId": "...",
			"guildId": "...",
			"guildName": "サーバー名（人間用ラベル、省略可）",
			"channelName": "チャンネル名（人間用ラベル、省略可）",
			"role": "home",
			"cooldownSeconds": 60
		}
	]
}
```

### heartbeat-config.json 構造

```json
{
	"baseIntervalMinutes": 1,
	"reminders": [
		{
			"id": "home-check",
			"description": "ホームチャンネルの様子を見る",
			"schedule": { "type": "interval", "minutes": 30 },
			"lastExecutedAt": null,
			"enabled": true
		}
	]
}
```

### SQLite テーブル（store/schema.ts）

- `sessions`: セッション永続化（key, sessionId, createdAt）
- `reminders`: Heartbeat リマインダー（id, guildId, description, scheduleType, scheduleValue, lastExecutedAt, enabled）
- `event_buffer`: イベントバッファ（guildId, payload, createdAt）
- `emoji_usage`: 絵文字使用カウント（guildId, emojiName, count）
- `heartbeat_config`: Heartbeat 基本設定（key, baseIntervalMinutes）

## 6. 主要シーケンス

### 6.1 メッセージルーティング（ポーリングモード）

1. Discord `messageCreate` を受信する。
2. Bot 自身のメッセージのみ除外する。他 Bot メッセージには `isBot` フラグを付与して処理を継続する。
3. メンション -> `bootstrap.ts` の `bufferIncomingMessage()` でイベントバッファに追加
4. ホームチャンネル（配下スレッド含む） -> `bufferIncomingMessage()` でイベントバッファに追加 + LTM 記録
5. その他 -> 無視
6. AI が `event-buffer` MCP ツールでバッファをポーリングし、自律的に応答を判断・送信する

### 6.2 Heartbeat 自律行動

1. `HeartbeatScheduler` が 1 分ごとに `tick()` を実行する。
2. Heartbeat 設定を読み込む。
3. `evaluateDueReminders()` で due なリマインダーを判定する。
4. due なリマインダーがあれば `InstrumentedAiAgent.send()` を呼ぶ。
5. due リマインダーを guildId でグループ化し、Guild ごとに別セッション `system:heartbeat:{guildId}` で逐次実行する（guildId なしは `system:heartbeat:_autonomous`）。
6. AI が MCP ツール（discord, code-exec, schedule）を使って自律的に行動する。
7. 成功時に `lastExecutedAt` を更新する。

### 6.3 セッション管理

1. セッションキーで既存セッション ID を検索する。
2. 存在すれば OpenCode API で有効性を検証する。
3. 無効なら新規セッションを作成し、SQLite に保存する。
4. 毎回ブートストラップコンテキストを `system` フィールドで送信する。

### 6.4 コンテキスト読込

1. 全ファイルはオーバーレイ方式で読み込む: `data/context/` -> `context/` の順でフォールバック。
2. 共通ファイル（`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`）は overlay -> base の順。
3. 記憶ファイル（`MEMORY.md`, `LESSONS.md`）は guildId 指定時に `guilds/{guildId}/` -> グローバルの順でフォールバック（各段階で overlay -> base）。
4. 当日の日次ログも同様に Guild 固有 -> グローバルの順（各段階で overlay -> base）。
5. **LTM ファクト注入**: `LtmFactReader` から蓄積済みファクトを取得し、`<ltm-facts>` セクションとして注入する。
6. 各ファイル 20,000 文字、合計 150,000 文字で切り詰め。
7. XML タグでラップして結合する。
8. guildId が存在する場合、`<guild-context>` タグで guild_id を明示し、MCP ツール使用時の指示を含める。

## 7. 設定

### 必須環境変数

- `DISCORD_TOKEN`: Discord API トークン（`.env` から読込）

### セッション管理

- `SESSION_MAX_AGE_HOURS`: セッション自動ローテーションの最大寿命（デフォルト: `48`）。超過したセッションは AgentRunner 再起動時に自動破棄される。

### OpenCode プロバイダ設定（AgentRunner 用）

- `OPENCODE_PROVIDER_ID`: プロバイダ ID（デフォルト: `"github-copilot"`）
- `OPENCODE_MODEL_ID`: モデル ID（デフォルト: `"big-pickle"`）

### LTM プロバイダ設定（FenghuangChatAdapter 用）

- `LTM_PROVIDER_ID`: LTM 用プロバイダ ID（フォールバック: `OPENCODE_PROVIDER_ID` -> `"github-copilot"`）
- `LTM_MODEL_ID`: LTM 用モデル ID（デフォルト: `"gpt-4o"`）
- `OLLAMA_BASE_URL`: Ollama API エンドポイント（デフォルト: `"http://ollama:11434"`、コンテナ間通信用）
- `LTM_EMBEDDING_MODEL`: 埋め込みモデル（デフォルト: `"embeddinggemma"`）

### Ollama コンテナ

- `compose.yaml` で `ollama` サービスとして定義（`docker.io/ollama/ollama:latest`、CPU 版）
- `bot` -> `ollama` のコンテナ間通信は `vicissitude-net` ブリッジネットワーク経由
- モデルデータは `ollama-data` ボリュームに永続化
- 初回起動時に `containers/ollama/entrypoint.sh` が `embeddinggemma` モデルを自動プル（`LTM_EMBEDDING_MODEL` 環境変数で変更可能）
- healthcheck (`ollama list`) で起動完了を確認し、`bot` は `service_healthy` 条件で待機

### Minecraft MCP サーバー設定（`MC_HOST` 設定時のみ有効）

- `MC_HOST`: Minecraft サーバーホスト（必須）
- `MC_PORT`: ポート（デフォルト: `25565`）
- `MC_USERNAME`: bot ユーザー名（デフォルト: `fua`）
- `MC_VERSION`: Minecraft バージョン指定（省略可、mineflayer 自動検出）

### ディレクトリ

- データディレクトリ: `{project-root}/data/`
- コンテキストディレクトリ: `{project-root}/context/`（ベース）、`{project-root}/data/context/`（オーバーレイ、読み込み優先）

## 8. エラーハンドリング

- AI セッションエラー: 指数バックオフで自動再起動し、ログに記録する。
- セッション検証失敗: 新規セッションを作成してリカバリする。
- コンテキストファイル不在: スキップして空文字を返す。
- 設定不備: 起動時に例外を投げて終了する。

## 9. テスト配置

- テストは実装モジュール近傍に同居配置する（`*.test.ts`）。
- テストランナーは Bun 組み込みテストランナーを使用する。
- テストヘルパーは `test-helpers.ts` に集約する。

## 10. 設計上の決定

1. 責務別フラットモジュール構成を採用する（Clean Architecture からの移行完了）。
2. DI は手動コンストラクタ注入のみ（Pure DI）。
3. MCP サーバーは独立プロセスとして 3 プロセス構成（core / code-exec / minecraft）。
4. セッション永続化は SQLite を使用する。
5. コンテキスト運用はオーバーレイ方式で行う: `context/`（git 管理・ベース）に人格定義やデフォルト値を配置し、`data/context/`（gitignore・オーバーレイ）にランタイム記憶やデプロイ固有設定を配置する。読み込みは `data/context/` -> `context/` のフォールバック、書き込みは常に `data/context/` に行う。
6. Guild 跨ぎコンテキスト分離: 人格（IDENTITY, SOUL 等）は共通、記憶（MEMORY, LESSONS, daily log）は Guild ごとに `guilds/{guildId}/` で分離する。DM やフォールバック時はグローバルを使用する。
7. 記憶システムの役割分離: ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）は運用特化型の構造化メモリとして維持し、LTM（fenghuang の Episodes/SemanticFacts）は会話から自動抽出される意味記憶を担当する。`ContextBuilder` は `LtmFactReader` を通じて LTM ファクトをシステムプロンプトに注入する。
8. Minecraft 拡張は既存エージェント基盤の置換ではなく、MCP サーバー追加で実装する。人格は 1 つに維持し、Minecraft は内部で分業する。
9. Minecraft 連携の意思決定はイベント駆動を基本にし、毎 tick 推論は行わない。LLM への入力は要約優先でコンテキスト過負荷を防ぐ。

## 11. Minecraft 拡張設計（計画）

### 11.1 目的

- Discord 雑談人格を維持したまま、Minecraft 上で最小限の自律行動を可能にする。
- 高頻度ゲーム状態をそのまま LLM に流さず、要約レイヤーで情報量を制御する。

### 11.2 内部責務分離

- Conversation persona layer: 既存の Discord 雑談応答生成
- Minecraft tool layer: mineflayer による移動・採集・クラフト等
- Minecraft state summarization layer: 生状態を短い要約へ変換
- Event-driven decision layer: 重要イベント時のみ再判断

### 11.3 イベント駆動フロー（想定）

1. Minecraft 側で重要イベント（危険接近、行動失敗、目標達成等）を検知する。
2. `minecraft` MCP サーバーが直近イベントを蓄積し、要約状態を生成する。
3. AI は必要時のみ `observe_state` / `get_recent_events` を参照して次行動を決定する。
4. 実行は `follow_player` / `go_to` / `collect_block` などの高レベルツールで行う。
5. 必要に応じて Discord へ自然文で状況共有する。

### 11.4 初期スコープ

- 接続、状態取得、追従、移動、基本採集、基本クラフト、装備、睡眠、チャット送信、直近イベント取得
- 非目標: 完全自律長期サバイバル、高度建築、複雑戦闘、全知覚リアルタイム推論
