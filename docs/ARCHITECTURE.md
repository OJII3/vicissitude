# ARCHITECTURE.md

## 1. 位置づけ

- 本書は、現在の実装構成（`src/` 配下モジュール構成）に基づく実装準拠アーキテクチャを定義する。
- Minecraft 拡張は「既存構成を維持した段階的追加」として、末尾の拡張設計セクションに記載する。
- 要件の正本は `SPEC.md`、運用方針の正本は `RUNBOOK.md`、進行状況の正本は `STATUS.md` とする。

## 2. 設計原則

- KISS: 小さい責務を明確な境界で分割する。
- YAGNI: 現行要件に不要な機能は導入しない。
- 軽量なレイヤード構成を採用する。`application` を中心に、`gateway`/`mcp` は interface adapter、`infrastructure` は外部依存 adapter とする。
- 手動コンストラクタ注入（Pure DI）のみ使用し、DI コンテナは導入しない。

## 3. システム境界

- 本体コード: `vicissitude` リポジトリ (`src/`)
- コンテキスト: `context/`（git 管理・ベース）+ `data/context/`（gitignore・オーバーレイ、読み込み優先）。Minecraft 用: `context/minecraft/`（IDENTITY, KNOWLEDGE, GOALS, SKILLS）
- データ: `data/` ディレクトリ（`vicissitude.db`（SQLite: sessions, event_buffer, emoji_usage, mc_bridge_events, mc_session_lock）、`heartbeat-config.json`（Heartbeat 設定・リマインダー）、`ltm/guilds/{guildId}/memory.db`、`context/`）
- 外部依存:
  - Discord API (`discord.js`)
  - OpenCode SDK (`@opencode-ai/sdk`)
  - MCP SDK (`@modelcontextprotocol/sdk`)
  - Drizzle ORM (`drizzle-orm`) + `bun:sqlite`
  - src/ltm/（LTM: Episode/SemanticFact 管理、モノレポ内蔵）
  - mineflayer + mineflayer-pathfinder（Minecraft 操作、`MC_HOST` 設定時のみ）

## 4. モジュール構成

> 自動生成される依存関係グラフも参照: [`docs/DEPS.md`](./DEPS.md)（commit 時に自動再生成）

```
src/
├── application/            # ユースケース
│   ├── heartbeat-service.ts         # due reminder 実行ユースケース
│   └── message-ingestion-service.ts # Discord 受信イベント取り込みユースケース
│
├── core/                    # 型定義・設定・純粋関数（外部依存なし）
│   ├── types.ts             # 型定義、値オブジェクト、インターフェース（OpencodeSessionPort 含む）
│   ├── config.ts            # Zod スキーマによる設定バリデーション
│   ├── constants.ts         # 共有定数（MC_BRAIN_GUILD_ID, METRIC, OPENCODE_ALL_TOOLS_DISABLED）
│   └── functions.ts         # splitMessage, evaluateDueReminders 等
│
├── agent/                   # OpenCode エージェント基盤
│   ├── profile.ts           # AgentProfile 型定義
│   ├── runner.ts            # AgentRunner（ポーリングループ）
│   ├── session-store.ts     # セッション永続化（SQLite）
│   ├── mcp-config.ts        # MCP サーバー設定（core / code-exec / minecraft / mc-bridge）
│   ├── discord/             # Discord/会話エージェント固有
│   │   ├── context-builder.ts   # システムプロンプト構築（LTM ファクト注入含む）
│   │   ├── profile.ts           # 会話エージェントプロファイル
│   │   └── router.ts            # GuildRouter（ギルド ID ベースのルーティング）
│   └── minecraft/           # Minecraft エージェント固有
│       ├── context-builder.ts   # Minecraft エージェント専用コンテキスト構築
│       ├── profile.ts           # Minecraft エージェントプロファイル
│       └── brain-manager.ts     # Minecraft エージェント生成・起動・停止管理
│
├── gateway/                 # 外部世界との接点（interface adapter）
│   ├── discord.ts           # DiscordGateway
│   └── channel-config-loader.ts  # チャンネル設定読み込み
│
├── infrastructure/          # 外部依存 adapter
│   ├── discord/
│   │   └── attachment-mapper.ts   # Discord 添付→内部 Attachment 変換
│   └── store/
│       └── sqlite-buffered-event-store.ts # BufferedEventStore の SQLite 実装
│
├── scheduling/              # スケジューラ（application 起動制御）
│   ├── heartbeat-scheduler.ts       # HeartbeatScheduler
│   ├── consolidation-scheduler.ts   # ConsolidationScheduler
│   └── heartbeat-config.ts          # JsonHeartbeatConfigRepository
│
├── mcp/                     # MCP サーバー（独立プロセス、レイヤー外）
│   ├── http-server.ts       # 共通 StreamableHTTP サーバー
│   ├── core-server.ts       # 統合 HTTP サーバー（discord + memory + schedule + event-buffer + ltm + mc-bridge）
│   ├── code-exec-server.ts  # コード実行（Podman サンドボックス）
│   ├── memory-helpers.ts    # メモリツール用ヘルパー関数
│   ├── minecraft/           # Minecraft（StreamableHTTP、MC_HOST 設定時のみ）+ ブリッジ MCP
│   │   ├── mc-bridge-server.ts # Minecraft ブリッジ MCP サーバー（mc-bridge + mc-memory）
│   │   ├── mc-metrics.ts    # MC プロセス専用 McMetricsCollector + Prometheus サーバー
│   │   └── ...
│   └── tools/               # ツール定義（registerXxxTools 関数）
│       ├── discord.ts
│       ├── memory.ts
│       ├── schedule.ts
│       ├── event-buffer.ts
│       ├── ltm.ts
│       ├── mc-bridge-discord.ts    # Discord 側ブリッジツール
│       ├── mc-bridge-minecraft.ts # Minecraft 側ブリッジツール
│       ├── mc-bridge-shared.ts  # ブリッジ共通ヘルパー
│       └── mc-memory.ts
│
├── store/                   # SQLite 統一永続化（Drizzle ORM）
│   ├── db.ts                # Drizzle クライアント初期化
│   ├── schema.ts            # 全テーブル定義
│   ├── queries.ts           # 共通クエリヘルパー
│   ├── mc-bridge.ts         # MC ブリッジクエリ関数
│   ├── mc-status-provider.ts       # Discord 側 MC 状態サマリー生成
│   └── minecraft-event-buffer.ts  # Minecraft エージェント用タイマーベース EventBuffer
│
├── observability/           # ログ・メトリクス
│   ├── logger.ts            # ConsoleLogger（NDJSON 構造化ログ）
│   └── metrics.ts           # PrometheusCollector + Server + InstrumentedAiAgent
│
├── opencode/                # OpenCode SDK 抽象化（Port/Adapter）
│   ├── session-port.ts      # OpencodeSessionPort インターフェース
│   └── session-adapter.ts   # OpencodeSessionAdapter（SDK 依存はここに集約）
│
├── ltm/                     # LTM（長期記憶）— エピソード・意味記憶・FSRS・ハイブリッド検索
│   ├── episode.ts                     # Episode 型 + createEpisode()
│   ├── semantic-fact.ts               # SemanticFact 型 + createFact()
│   ├── fsrs.ts                        # FSRS カード・retrievability・reviewCard
│   ├── types.ts                       # ChatMessage, FactCategory, MessageRole 等
│   ├── utils.ts                       # escapeXmlContent(), validateUserId()
│   ├── segmenter.ts                   # Segmenter（会話分節化）
│   ├── episodic.ts                    # EpisodicMemory
│   ├── consolidation.ts              # ConsolidationPipeline（エピソード→ファクト抽出）
│   ├── semantic-memory.ts             # SemanticMemory
│   ├── retrieval.ts                   # Retrieval + reciprocalRankFusion（ハイブリッド検索）
│   ├── ltm-storage.ts                 # LtmStorage（SQLite + FTS5 + ベクトル検索）
│   ├── llm-port.ts                    # LtmLlmPort インターフェース
│   ├── composite-llm-adapter.ts       # CompositeLLMAdapter（chat + embed の合成）
│   ├── ltm-chat-adapter.ts            # LtmChatAdapter（OpencodeSessionPort 経由）
│   ├── conversation-recorder.ts       # LtmConversationRecorder（会話記録 + 統合）
│   ├── fact-reader.ts                 # LtmFactReaderImpl（SQLite 読み取り専用）
│   └── index.ts                       # createLtm() + public exports
│
├── ollama/                  # Ollama 埋め込みアダプタ
│   └── ollama-embedding-adapter.ts    # OllamaEmbeddingAdapter（HTTP API）
│
├── bootstrap.ts             # DI 配線エントリポイント
└── index.ts                 # アプリケーションエントリポイント
```

### 4.1 core/ — 型・設定・純粋関数

- `types.ts`: 全エンティティ型、インターフェース（`OpencodeSessionPort`, `ConversationRecorder`, `MemoryConsolidator`, `LtmFactReader` 等）
- `config.ts`: Zod スキーマで全環境変数をバリデーション。`loadConfig()` で `AppConfig` を返す。`coreMcpPort` を含む
- `constants.ts`: 共有定数（`MC_BRAIN_GUILD_ID`, `METRIC`, `OPENCODE_ALL_TOOLS_DISABLED`）
- `functions.ts`: `splitMessage()`, `evaluateDueReminders()`, `labelsToKey()`, `recordTokenMetrics()` 等の純粋関数

### 4.2 agent/ — OpenCode エージェント基盤

- `profile.ts`: `AgentProfile` 型定義（name, mcpServers, builtinTools, model 等）
- `runner.ts`: `AgentRunner` — `AgentProfile` + `OpencodeSessionPort` を受け取り、初回イベントで長寿命 `promptAsync()` セッションを起動し、以後はセッション終了イベントを監視して再起動する。セッション自動ローテーション（`SESSION_MAX_AGE_HOURS`、デフォルト 48 時間）は再起動契機時に適用
- `session-store.ts`: `SessionStore` — SQLite でセッション ID を永続化
- `mcp-config.ts`: `mcpServerConfigs()` — Discord エージェント用 MCP サーバー設定（core: remote, code-exec: local）。`mcpMinecraftConfigs()` — Minecraft エージェント用 MCP サーバー設定（mc-bridge / minecraft）
- `discord/router.ts`: `GuildRouter` — ギルド ID に基づいて適切なギルド固有エージェントにルーティングするファサード。`guildId` 未指定時は `defaultAgent` にフォールバック
- `discord/context-builder.ts`: `ContextBuilder` — オーバーレイ方式でコンテキストファイルを読み込み、LTM ファクトを注入してシステムプロンプトを構築
- `discord/profile.ts`: 会話エージェントプロファイル
- `minecraft/context-builder.ts`: `MinecraftContextBuilder` — Minecraft エージェント専用コンテキスト構築（Guild 非依存、オーバーレイ方式）
- `minecraft/profile.ts`: Minecraft エージェントプロファイル（全ビルトインツール無効、MCP ツールのみ使用）
- `minecraft/brain-manager.ts`: `McBrainManager` — Minecraft エージェントの生成・起動・停止を管理（ブリッジ lifecycle ポーリング）

### 4.3 application/ — ユースケース

- `message-ingestion-service.ts`: `IncomingMessage` を `BufferedEvent` と LTM 会話記録に変換する
- `heartbeat-service.ts`: due reminder を Guild 単位で実行し、成功した reminder ID を返す

### 4.4 gateway/ — 外部世界との接点

- `discord.ts`: `DiscordGateway` — discord.js Client でメッセージ受信。ルーティング: メンション/スレッド -> onMessage、ホームチャンネル -> onHomeChannelMessage。`onEmojiUsed()` でカスタム絵文字トラッキング
- `channel-config-loader.ts`: `channels.json` からホームチャンネル/Guild 対応を読み込む

### 4.5 infrastructure/ — 外部依存 adapter

- `discord/attachment-mapper.ts`: Discord.js の添付オブジェクトを内部 `Attachment` に変換
- `store/sqlite-buffered-event-store.ts`: application の `BufferedEventStore` を SQLite に保存する

### 4.6 scheduling/ — スケジューラ（application 起動制御）

- `heartbeat-scheduler.ts`: `HeartbeatScheduler` — 1 分間隔で `tick()` を実行し、due なリマインダーを検知して `HeartbeatService` を起動する
- `consolidation-scheduler.ts`: `ConsolidationScheduler` — 30 分間隔（初回 5 分遅延）で LTM メモリ統合を実行
- `heartbeat-config.ts`: `JsonHeartbeatConfigRepository` — `data/heartbeat-config.json` の読み書きを管理

### 4.7 mcp/ — MCP サーバー（独立プロセス）

MCP サーバーは 4 プロセス構成:

1. **core-server.ts** (`type: "remote"`, StreamableHTTP): Discord 操作 + メモリ管理 + スケジュール管理 + イベントバッファ + LTM + MC ブリッジ（Discord 側）を統合した HTTP サーバー。全 guild で 1 プロセスを共有し、guild_id はツールパラメータで指定する
   - `tools/discord.ts`: `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`, `list_channels`
   - `tools/memory.ts`: `read_memory`, `update_memory`, `read_soul`, `append_daily_log`, `read_daily_log`, `list_daily_logs`, `read_lessons`, `update_lessons`
   - `tools/schedule.ts`: `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
   - `tools/event-buffer.ts`: `wait_for_events` — SQLite ベース
   - `tools/ltm.ts`: `ltm_retrieve`, `ltm_consolidate`, `ltm_get_facts`
   - `tools/mc-bridge-discord.ts`（Discord 側）: `minecraft_delegate`, `minecraft_status`, `minecraft_read_reports`, `minecraft_start_session`, `minecraft_stop_session`
2. **code-exec-server.ts** (`type: "local"`): `execute_code` — Podman コンテナでサンドボックス実行
3. **minecraft/server.ts** (`type: "remote"`、`MC_HOST` 設定時のみ): StreamableHTTP サーバー
   - `observe_state`, `get_recent_events`, `follow_player`, `go_to`, `collect_block`, `stop`, `get_job_status`, `get_viewer_url`, `craft_item`, `place_block`, `equip_item`, `sleep_in_bed`, `send_chat`, `eat_food`, `flee_from_entity`, `find_shelter`, `attack_entity`
4. **minecraft/mc-bridge-server.ts** (`type: "local"`、Minecraft 側専用): Minecraft ブリッジ + メモリ MCP サーバー
   - `tools/mc-bridge-minecraft.ts`（Minecraft 側）: `mc_report`, `mc_read_commands`
   - `tools/mc-memory.ts`: `mc_read_goals`, `mc_update_goals`, `mc_read_skills`, `mc_record_skill`, `mc_read_progress`, `mc_update_progress`

### 4.8 store/ — SQLite 統一永続化

- `db.ts`: Drizzle クライアント初期化（`bun:sqlite`）
- `schema.ts`: テーブル定義（sessions, event_buffer, emoji_usage, mc_bridge_events, mc_session_lock）
- `event-buffer.ts`: `SqliteEventBuffer` — Guild 別イベントバッファ（`EventBuffer` インターフェース実装）
- `queries.ts`: 共通クエリヘルパー（`appendEvent`, `hasEvents`, `consumeEvents`, `incrementEmoji` 等）
- `mc-bridge.ts`: MC ブリッジクエリ（`insertBridgeEvent`, `consumeBridgeEvents`, `consumeBridgeEventsByType`, `peekBridgeEvents`, `hasBridgeEvents`）
- `mc-status-provider.ts`: `SqliteMcStatusProvider` — ブリッジレポート + MINECRAFT-GOALS.md から Discord 側 MC 状態サマリーを生成
- `minecraft-event-buffer.ts`: `MinecraftEventBuffer` — タイマーベースの EventBuffer 実装（30秒間隔ポーリング用）

### 4.7 observability/ — ログ・メトリクス

- `logger.ts`: `ConsoleLogger` — JSON 構造化ログ（NDJSON）を stdout/stderr に出力
- `metrics.ts`: `PrometheusCollector` + `PrometheusServer` + `InstrumentedAiAgent`（`METRIC` は `core/constants.ts` から re-export）

メトリクス一覧（17個）:

| 名前                                      | 型        | ラベル                             | 説明                                               |
| ----------------------------------------- | --------- | ---------------------------------- | -------------------------------------------------- |
| `discord_messages_received_total`         | Counter   | `channel_type`                     | Discord メッセージ受信数                           |
| `ai_requests_total`                       | Counter   | `agent_type`, `trigger`, `outcome` | AI リクエスト数                                    |
| `heartbeat_ticks_total`                   | Counter   | `outcome`                          | Heartbeat tick 数                                  |
| `heartbeat_reminders_executed_total`      | Counter   | —                                  | Heartbeat リマインダー実行数                       |
| `bot_info`                                | Gauge     | `bot_name`                         | Bot 情報                                           |
| `ai_request_duration_seconds`             | Histogram | —                                  | AI リクエスト所要時間                              |
| `heartbeat_tick_duration_seconds`         | Histogram | —                                  | Heartbeat tick 所要時間                            |
| `llm_active_sessions`                     | Gauge     | —                                  | アクティブ LLM セッション数                        |
| `llm_busy_sessions`                       | Gauge     | `agent_type`                       | 処理中 LLM セッション数                            |
| `ltm_consolidation_ticks_total`           | Counter   | `outcome`                          | LTM 統合 tick 数                                   |
| `ltm_consolidation_tick_duration_seconds` | Histogram | —                                  | LTM 統合 tick 所要時間                             |
| `llm_input_tokens_total`                  | Counter   | `agent_type`, `trigger`            | LLM 入力トークン累計                               |
| `llm_output_tokens_total`                 | Counter   | `agent_type`, `trigger`            | LLM 出力トークン累計                               |
| `llm_cache_read_tokens_total`             | Counter   | `agent_type`, `trigger`            | LLM キャッシュ読取トークン累計                     |
| `mc_jobs_total`                           | Counter   | `type`, `status`                   | MC ジョブ完了/失敗/キャンセル数                    |
| `mc_bot_events_total`                     | Counter   | `kind`                             | MC ボットイベント（spawn/death/kicked/disconnect） |
| `mc_mcp_tool_calls_total`                 | Counter   | `tool`                             | MC MCP ツール呼び出し数                            |

トークンメトリクスはメインプロセス（ポート 9091）、MC メトリクスは MC MCP プロセス（ポート 9092、`MC_METRICS_PORT` で変更可）で公開される。

### 4.8 opencode/ — OpenCode SDK 抽象化

- `session-port.ts`: `core/types.ts` の `OpencodeSessionPort` 型を re-export（後方互換用）。Port 定義の正本は `core/types.ts`
- `session-adapter.ts`: `OpencodeSessionAdapter` — `@opencode-ai/sdk/v2` の `createOpencode` を使う唯一のファイル。遅延初期化パターンで、最初のメソッド呼び出し時にサーバープロセスを起動

### 4.9 ltm/ — 長期記憶

旧 `fenghuang` 外部パッケージをモノレポに統合。StoragePort を廃止し SQLite（`bun:sqlite`）直接依存。

- `ltm-storage.ts`: `LtmStorage` — SQLite + FTS5 テキスト検索 + コサイン類似度ベクトル検索。WAL モードで安全な同時アクセス
- `segmenter.ts`: `Segmenter` — 会話メッセージキューを soft/hard トリガーで分節化し Episode を生成
- `consolidation.ts`: `ConsolidationPipeline` — Episode から SemanticFact を LLM で抽出・統合
- `retrieval.ts`: `Retrieval` — テキスト + ベクトル + FSRS の Reciprocal Rank Fusion ハイブリッド検索
- `composite-llm-adapter.ts`: `CompositeLLMAdapter implements LtmLlmPort` — chat を `LtmChatAdapter`、embed を `OllamaEmbeddingAdapter` に委譲
- `ltm-chat-adapter.ts`: `LtmChatAdapter` — `OpencodeSessionPort` 経由で LtmLlmPort 用 chat/chatStructured を提供
- `conversation-recorder.ts`: `LtmConversationRecorder` — Guild ごとの会話記録 + メモリ統合。`ConversationRecorder` + `MemoryConsolidator` インターフェースを実装
- `fact-reader.ts`: `LtmFactReaderImpl` — Guild ごとの SQLite DB から SemanticFact を読み取り専用で取得。WAL モードで安全に同時アクセス

### 4.10 ollama/ — 埋め込みアダプタ

- `ollama-embedding-adapter.ts`: `OllamaEmbeddingAdapter` — Ollama HTTP API でテキスト埋め込みベクトルを取得（30 秒タイムアウト）

### 4.11 bootstrap.ts — DI 配線

- `bootstrap()` — DI 配線のエントリポイント。内部は独立テスト可能な factory 関数に分解:
  - `createStoreLayer()` — DB + SessionStore の初期化
  - `createContextLayer()` — LtmFactReader + McStatusProvider + ContextBuilder の構築
  - `createGuildAgents()` — ギルドごとに `AgentRunner` を生成し `GuildRouter` でラップ
  - `createMetrics()` — PrometheusCollector + Server の初期化
  - `setupLtmRecording()` — LTM 記録の構成
  - `startCoreMcp()` — core MCP HTTP プロセスの起動 + health check
- LTM 記録、Heartbeat スケジューラ、Consolidation スケジューラを起動
- core MCP と Minecraft MCP を子プロセスとして起動（Minecraft は `MC_HOST` 設定時のみ）
- Minecraft エージェント（`AgentRunner` + `MinecraftEventBuffer`）を起動（`config.minecraft` 存在時のみ）
- Graceful shutdown（SIGINT/SIGTERM）実装済み

### 4.12 OpenCode 組み込みツール

`AgentRunner` では以下の OpenCode SDK 組み込みツールを有効化している:

- `webfetch`: 指定 URL の内容を取得
- `websearch`: Web 検索を実行

その他の組み込みツール（`read`, `edit`, `write`, `bash`, `glob`, `grep`, `task`, `question`, `todowrite`, `skill`）は無効化している。

## 5. データモデル

### AgentResponse

- `text: string`
- `sessionId: string`
- `tokens?: TokenUsage` — トークン使用量（`{ input, output, cacheRead }`）

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
- `event_buffer`: イベントバッファ（guildId, payload, createdAt）
- `emoji_usage`: 絵文字使用カウント（guildId, emojiName, count）
- `mc_bridge_events`: MC ブリッジイベント（direction, type, payload, createdAt, consumed）
- `mc_session_lock`: MC セッション排他ロック（id=1 固定、guildId, acquiredAt）— 最大1行、2時間タイムアウト

### JSON ファイル

- `data/heartbeat-config.json`: Heartbeat 設定（baseIntervalMinutes, reminders 配列）— 構造は上記「heartbeat-config.json 構造」を参照

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
   5.1. **Minecraft 状態注入**（`config.minecraft` 設定時のみ）: `McStatusProvider` から Minecraft 側のレポートと目標を取得し、`<minecraft-status>` セクションとして注入する。
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

### LTM プロバイダ設定（LtmChatAdapter 用）

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
- `MC_USERNAME`: bot ユーザー名（デフォルト: `hua`）
- `MC_VERSION`: Minecraft バージョン指定（省略可、mineflayer 自動検出）

### Minecraft エージェント設定（`MC_HOST` 設定時のみ有効）

- `MC_PROVIDER_ID`: Minecraft エージェント用プロバイダ ID（フォールバック: `OPENCODE_PROVIDER_ID` -> `"github-copilot"`）
- `MC_MODEL_ID`: Minecraft エージェント用モデル ID（フォールバック: `OPENCODE_MODEL_ID` -> `"big-pickle"`）

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
3. MCP サーバーは独立プロセスとして 4 プロセス構成（core（HTTP、全 guild 共有） / code-exec / minecraft / mc-bridge）。
4. セッション永続化は SQLite を使用する。
5. コンテキスト運用はオーバーレイ方式で行う: `context/`（git 管理・ベース）に人格定義やデフォルト値を配置し、`data/context/`（gitignore・オーバーレイ）にランタイム記憶やデプロイ固有設定を配置する。読み込みは `data/context/` -> `context/` のフォールバック、書き込みは常に `data/context/` に行う。
6. Guild 跨ぎコンテキスト分離: 人格（IDENTITY, SOUL 等）は共通、記憶（MEMORY, LESSONS, daily log）は Guild ごとに `guilds/{guildId}/` で分離する。DM やフォールバック時はグローバルを使用する。
7. 記憶システムの役割分離: ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）は運用特化型の構造化メモリとして維持し、LTM（src/ltm/ の Episodes/SemanticFacts）は会話から自動抽出される意味記憶を担当する。`ContextBuilder` は `LtmFactReader` を通じて LTM ファクトをシステムプロンプトに注入する。
8. Minecraft 拡張は既存エージェント基盤の置換ではなく、MCP サーバー追加で実装する。人格は 1 つに維持し、Minecraft は内部で分業する。
9. Minecraft 連携の意思決定はイベント駆動を目標とする。現行実装は 30 秒ポーリングをベースとしつつ、M13 で危険時即応と再計画経路を強化する。LLM への入力は要約優先でコンテキスト過負荷を防ぐ。

## 11. Minecraft 拡張設計（計画）

### 11.1 MCP サーバーライフサイクル

- MCP HTTP サーバーは OpenCode より先に ready でなければならない（OpenCode が接続できないとエージェント全体が機能しない）
- 起動順序: HTTP サーバー起動 → health check 通過 → Minecraft bot 接続開始
- Minecraft bot 接続は MCP HTTP サーバー起動後に遅延実行される（既存の exponential backoff reconnect が活きる）
- bot 未接続時は MCP ツールが「ボット未接続」を返す（graceful degradation）
- `bootstrap.ts` は `GET /health` で readiness を確認する。タイムアウトしてもプロセスは kill しない

### 11.2 目的

- Discord 雑談人格を維持したまま、Minecraft 上で最小限の自律行動を可能にする。
- 高頻度ゲーム状態をそのまま LLM に流さず、要約レイヤーで情報量を制御する。

### 11.3 内部責務分離

- Conversation persona layer: 既存の Discord 雑談応答生成
- Minecraft tool layer: mineflayer による移動・採集・クラフト等
- Minecraft state summarization layer: 生状態を短い要約へ変換
- Event-driven decision layer: 重要イベント時のみ再判断

### 11.3.1 現行構成

- `agent/minecraft/profile.ts` の単一プロンプトが、観察、優先度判断、実行、報告、目標更新をまとめて担当する。
- `agent/minecraft/brain-manager.ts` は Minecraft 専用 `AgentRunner` の起動停止だけを担い、内部認知分業は持たない。
- Discord 側との接続点は Event Bridge のみであり、Minecraft 側は高レベル指示と報告を非同期メッセージとして扱う。

### 11.4 イベント駆動フロー（想定）

1. Minecraft 側で重要イベント（危険接近、行動失敗、目標達成等）を検知する。
2. `minecraft` MCP サーバーが直近イベントを蓄積し、要約状態を生成する。
3. AI は必要時のみ `observe_state` / `get_recent_events` を参照して次行動を決定する。
4. 実行は `follow_player` / `go_to` / `collect_block` などの高レベルツールで行う。
5. 必要に応じて Discord へ自然文で状況共有する。

### 11.5 初期スコープ

- 接続、状態取得、追従、移動、基本採集、基本クラフト、装備、睡眠、チャット送信、直近イベント取得、基本戦闘（近接攻撃）
- 非目標: 完全自律長期サバイバル、高度建築、高度戦闘（PvP・遠距離攻撃・複数対象連携等）、全知覚リアルタイム推論

### 11.6 M13a ギャップ分析

- 即応性不足: 危険時のプリエンプションは wake file で部分対応済みだが、完全なイベント直結ではない。
- 長期進捗不足: `MINECRAFT-GOALS.md` と `MINECRAFT-SKILLS.md` だけでは、拠点状態や技術段階、探索済み領域を保持しにくい。
- 社会行動不足: Discord 依頼、緊急回避、自律目標の優先順位と説明責任が未整理である。
- 安全機構: 失敗分類（5 類型）とクールダウンは実装済み。stuck 判定と Discord 自動通知は未実装。

### 11.7 M13c 実行安全性設計

#### 11.7.1 危険時プリエンプション

- 危険イベント入力は `get_recent_events(importance >= medium)` と `observe_state` の危険要約を起点に判定する。
- `death`, `kicked`, `disconnect` は最優先で即時に通常フローを打ち切る。
- `damage`、近距離 hostile mob、致命的低体力、空腹 0 は高優先度イベントとして扱い、進行中ジョブより優先する。
- プリエンプション時の標準手順は `stop` → 状況再観測 → `eat_food` / `flee_from_entity` / `find_shelter` / `sleep_in_bed` のいずれかを 1 手だけ選ぶ。
- 危険時フローでは新規の採集、探索、クラフト長期ジョブを開始しない。

#### 11.7.2 ジョブ中断・再試行・クールダウン

- `JobManager` は新規ジョブ開始時に既存ジョブを自動キャンセルするため、M13c ではその挙動を安全系ジョブの標準中断機構として扱う。
- ジョブ失敗時は `get_job_status` と直近イベントから失敗理由を分類する。
- 同系統ジョブが連続 2 回失敗またはキャンセルした場合、そのジョブ種別はクールダウン対象とし、同条件での即再試行を避ける。
- 再試行は、体力回復、空腹解消、昼夜変化、対象再発見、位置変化など前提条件の変化が観測された場合に限る。
- stuck 判定は「進行中ジョブがあるのに進捗更新がなく、同種失敗が繰り返される」ケースとして扱い、再計画か停止報告へ切り替える。

#### 11.7.3 失敗時標準ハンドリング

- 失敗は `survival failure`, `pathfinding failure`, `resource shortage`, `target missing`, `connection failure` の 5 類型で扱う。
- `survival failure`: 目標系処理を中断し、生存行動へ移る。
- `pathfinding failure`: 同一目標への即再試行を避け、代替行動か一段短い移動へ分解する。
- `resource shortage`: 不足資源を理由付きで記録し、代替案がなければ目標を保留する。
- `target missing`: 周辺再観測を 1 回だけ許可し、見つからなければ失敗確定する。
- `connection failure`: Minecraft 側の再接続を待ち、Discord 側へ停止または遅延を通知する。

#### 11.7.4 Discord 通知条件

- 即時通知: `death`, `kicked`, `disconnect`, 危険回避開始、危険回避失敗、依頼失敗。
- 要約通知: 危険回避完了、再計画開始、長時間スタック、依頼延期。
- 非通知: 軽微な低重要度イベント、単発の通常ジョブ完了、クールダウン中の内部再評価。
