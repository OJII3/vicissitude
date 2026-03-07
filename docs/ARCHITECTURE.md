# ARCHITECTURE.md

## 1. 位置づけ

- 本書は、現在の実装構成（`src/` 配下 Clean Architecture）に基づく実装準拠アーキテクチャを定義する。
- 要件の正本は `SPEC.md`、運用方針の正本は `RUNBOOK.md`、進行状況の正本は `STATUS.md` とする。

## 2. 設計原則

- KISS: 小さい責務を明確な境界で分割する。
- YAGNI: 現行要件に不要な機能は導入しない。
- Clean Architecture + Ports and Adapters を採用する。
- 手動コンストラクタ注入（Pure DI）のみ使用し、DI コンテナは導入しない。

## 3. システム境界

- 本体コード: `vicissitude` リポジトリ (`src/`)
- コンテキスト: `context/`（git 管理・ベース）+ `data/context/`（gitignore・オーバーレイ、読み込み優先）
- データ: `data/` ディレクトリ（`sessions.json`, `heartbeat-config.json`, `emoji-usage.json`, `context/`, `event-buffer/guilds/{guildId}/`）
- 外部依存:
  - Discord API (`discord.js`)
  - OpenCode SDK (`@opencode-ai/sdk`)
  - MCP SDK (`@modelcontextprotocol/sdk`)

## 4. レイヤー構成

### 4.1 Domain 層 — 純粋 TS、外部依存なし

#### entities/

- `agent-response.ts`: `AgentResponse` — AI 応答の型定義
  - `text: string` — 応答テキスト
  - `sessionId: string` — セッション ID
- `session.ts`: `SessionKey` 型 + `createSessionKey()` / `createChannelSessionKey()` — セッションキー生成
  - ユーザー単位: `{platform}:{channelId}:{authorId}`
  - チャンネル単位: `{platform}:{channelId}:_channel`
- `channel-config.ts`: `ChannelRole`, `ChannelConfig` — チャンネル設定
- `attachment.ts`: `Attachment` — 添付ファイル情報（`url: string`, `contentType?: string`, `filename?: string`）
- `emoji-usage.ts`: `EmojiUsageCount` — カスタム絵文字使用カウント（`emojiName`, `count`）
- `heartbeat-config.ts`: `HeartbeatConfig`, `HeartbeatReminder` (`guildId?` フィールド追加), `DueReminder`, `ReminderSchedule` — Heartbeat 設定

#### ports/

- `ai-agent.port.ts`: `AiAgent` — AI エージェントのインターフェース
  - `send(options: SendOptions): Promise<AgentResponse>` — `SendOptions = { sessionKey, message, guildId?, attachments?: Attachment[] }`
  - `stop(): void`
- `context-loader.port.ts`: `ContextLoader` + `ContextLoaderFactory` — コンテキスト読込
  - `ContextLoader`: `loadBootstrapContext()`
  - `ContextLoaderFactory`: `create(guildId?): ContextLoader` — Guild 単位でローダーを生成
- `logger.port.ts`: `Logger` — ログ出力
  - `info()`, `error()`, `warn()`
- `message-gateway.port.ts`:
  - `IncomingMessage` — 受信メッセージ（`platform`, `channelId`, `guildId?`, `authorId`, `authorName`, `messageId`, `content`, `attachments: Attachment[]`, `timestamp`, `isMentioned`, `isThread`, `isBot`, `reply()`, `react()`）
  - `MessageChannel` — チャンネル操作（`sendTyping()`, `send()`)
  - `MessageGateway` — ゲートウェイ（`onMessage()`, `onHomeChannelMessage()`, `start()`, `stop()`)
- `channel-config-loader.port.ts`: `ChannelConfigLoader` — チャンネル設定読込
  - `getRole(channelId)`, `getCooldown(channelId)`, `getGuildIds()`
- `emoji-usage-tracker.port.ts`: `EmojiUsageTracker` — カスタム絵文字使用頻度トラッキング
  - `increment(guildId, emojiName)`, `getTopEmojis(guildId, limit)`, `hasData(guildId)`
- `session-repository.port.ts`: `SessionRepository` — セッション永続化
  - `get()`, `save()`, `exists()`
- `heartbeat-config-repository.port.ts`: `HeartbeatConfigRepository` — Heartbeat 設定永続化
  - `load()`, `save()`, `updateLastExecuted()`
- `event-buffer.port.ts`: `EventBuffer` — イベントバッファ（ポーリング用）
  - `append(event: BufferedEvent): Promise<void>`
  - `BufferedEvent`: `ts`, `channelId`, `guildId?`, `authorId`, `authorName`, `messageId`, `content`, `attachments?: Attachment[]`, `isMentioned`, `isThread`, `isBot`

#### services/

- `message-formatter.ts`: `splitMessage()` — 2000 文字制限でのメッセージ分割（純粋関数）
- `heartbeat-evaluator.ts`: `evaluateDueReminders()` — Heartbeat 設定から due なリマインダーを判定（純粋関数）

### 4.2 Application 層 — ユースケース

- `handle-heartbeat.use-case.ts`: `HandleHeartbeatUseCase`
  - 依存: `AiAgent`, `HeartbeatConfigRepository`, `Logger`
  - 処理: due リマインダーからプロンプト構築 → AI セッション起動 → lastExecutedAt 更新
  - 用途: Heartbeat 自律行動
- `buffer-event.use-case.ts`: `BufferEventUseCase`
  - 依存: `EventBuffer`, `Logger`
  - 処理: `IncomingMessage` → `BufferedEvent` に変換してバッファに追加
  - 用途: イベントバッファリング（AI がポーリングで消費）

### 4.3 Infrastructure 層 — ポートの具象実装

- `discord/discord-gateway.ts`: `DiscordGateway implements MessageGateway`
  - discord.js Client でメッセージ受信
  - ルーティング: メンション/スレッド → onMessage、ホームチャンネル → onHomeChannelMessage、それ以外 → 無視
  - メンション文字列 (`<@!?\d+>`) を除去
  - `onEmojiUsed(handler)`: カスタム絵文字使用イベントのハンドラ登録（具象メソッド、ポート外）
  - `messageCreate` 内でカスタム絵文字（`<:name:id>` / `<a:name:id>`）を正規表現で検出してハンドラ呼び出し
  - `MessageReactionAdd` イベントを購読し、カスタム絵文字リアクションでハンドラ呼び出し
  - `Partials.Reaction`, `Partials.Message`, `Partials.Channel` を有効化（キャッシュ外メッセージへのリアクション受信に必要）
- `discord/discord-attachment-mapper.ts`: `mapDiscordAttachments()` — Discord 添付ファイルから画像 MIME タイプ（`image/png`, `image/jpeg`, `image/gif`, `image/webp`）のみを allowlist フィルタリングし `Attachment[]` に変換
- `opencode/polling-agent.ts`: `PollingAgent implements AiAgent`
  - `send()`: EventBuffer にイベントを書き込み、即座に空レスポンスを返す
  - `startPollingLoop()`: 1回の `promptAsync()` で AI がバッファをポーリングし続ける長寿命セッション
  - SSE で `session.idle`/`session.error` を検知し、指数バックオフで自動再起動
  - MCP 設定に `event-buffer` を追加で含む
- `opencode/guild-routing-agent.ts`: `GuildRoutingAgent implements AiAgent`
  - ギルド ID に基づいて適切なギルド固有エージェントにルーティングするファサード
  - `send()`: `options.guildId` で対応するギルド固有エージェントに委譲。`guildId` 未指定時は `defaultAgent` にフォールバック（Heartbeat の `_autonomous` リマインダー用）
  - `stop()`: 全ギルドエージェントを停止
  - Heartbeat 等の既存ユースケースが変更不要になる
- `opencode/mcp-config.ts`: `mcpServerConfigs(options?)` — MCP サーバー設定
  - `includeEventBuffer: true` で event-buffer MCP サーバーを含む（PollingAgent 用）
  - `guildId` 指定時はギルド別バッファパスを `EVENT_BUFFER_DIR` 環境変数で渡す
- `persistence/json-session-repository.ts`: `JsonSessionRepository implements SessionRepository`
  - `data/sessions.json` にセッション ID を永続化
  - インメモリキャッシュ + lazy load
- `context/file-context-loader.ts`: `FileContextLoader implements ContextLoader`
  - `overlayDir`（`data/context/`）→ `baseDir`（`context/`）のフォールバックで Markdown ファイルを読込・結合
  - Guild-aware: 共通ファイル（IDENTITY, SOUL 等）は overlay → base、記憶ファイル（MEMORY, LESSONS, daily log）は `guilds/{guildId}/` → グローバルの順で読込（各段階で overlay → base フォールバック）
- `context/file-context-loader-factory.ts`: `FileContextLoaderFactory implements ContextLoaderFactory`
  - `overlayDir` と `baseDir` を保持し、Guild ID を指定して `FileContextLoader` を生成
- `context/json-channel-config-loader.ts`: `JsonChannelConfigLoader implements ChannelConfigLoader`
  - `data/context/channels.json` → `context/channels.json` のフォールバックでチャンネル設定を読込
  - `getHomeChannelIds()` でホームチャンネル一覧を取得（ポート外の具象メソッド）
- `persistence/json-emoji-usage-repository.ts`: `JsonEmojiUsageRepository implements EmojiUsageTracker`
  - `data/emoji-usage.json` に絵文字使用カウントを永続化
  - インメモリキャッシュ + 30 秒遅延フラッシュ（graceful shutdown 時は即時フラッシュ）
- `persistence/json-heartbeat-config-repository.ts`: `JsonHeartbeatConfigRepository implements HeartbeatConfigRepository`
  - `data/heartbeat-config.json` に設定を永続化
  - ファイル不在時はデフォルト設定を返す
- `persistence/file-event-buffer.ts`: `FileEventBuffer implements EventBuffer`
  - JSONL 形式で append
  - ポーリングモード用
  - ギルド分離: `data/event-buffer/guilds/{guildId}/events.jsonl` にギルドごとに書き込み
- `scheduler/interval-heartbeat-scheduler.ts`: `IntervalHeartbeatScheduler`
  - 1分間隔の `setInterval` ループ
  - `running` フラグで重複実行を防止
- `logging/console-logger.ts`: `ConsoleLogger implements Logger` — JSON 構造化ログ（NDJSON）を `process.stdout/stderr` に出力。`[component]` プレフィックスを `component` フィールドに抽出。journald + Grafana Loki 連携を想定。
- `fenghuang/fenghuang-chat-adapter.ts`: `FenghuangChatAdapter` — OpenCode SDK を使って chat / chatStructured を提供するアダプタ。fenghuang の LLMPort 用。独自の OpenCode インスタンスをポート `LTM_OPENCODE_PORT` で起動し、全組み込みツール・MCP を無効化。
- `ollama/ollama-embedding-adapter.ts`: `OllamaEmbeddingAdapter` — Ollama HTTP API でテキスト埋め込みベクトルを取得するアダプタ。30 秒タイムアウト。
- `fenghuang/composite-llm-adapter.ts`: `CompositeLLMAdapter implements LLMPort` — chat/chatStructured を `FenghuangChatAdapter`、embed を `OllamaEmbeddingAdapter` に委譲するコンポジットアダプタ。ltm-server で使用。

### 4.4 MCP サーバー（独立プロセス、レイヤー外）

- `mcp/discord-server.ts`: Discord 操作ツール
  - `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`, `list_channels`
- `mcp/code-exec-server.ts`: コード実行ツール
  - `execute_code` (JS/TS/Python/Shell)
  - Podman コンテナでサンドボックス実行（ネットワーク遮断、読み取り専用 rootfs、全ケーパビリティ削除）
  - コード長上限 10,000 文字、出力 50KB 切り詰め、15 秒タイムアウト
  - 起動時に podman とコンテナイメージの存在を検証
- `mcp/schedule-server.ts`: Heartbeat スケジュール管理ツール
  - `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
  - `data/heartbeat-config.json` を直接読み書き
- `mcp/memory-server.ts`: メモリ管理ツール
  - `read_memory`, `update_memory`, `read_soul`, `evolve_soul`, `append_daily_log`, `read_daily_log`, `list_daily_logs`, `read_lessons`, `update_lessons`
  - オーバーレイ方式: 読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/` に行う
  - Guild 分離: `guild_id` パラメータ指定時は `guilds/{guildId}/` 配下を使用、省略時はグローバル
  - `evolve_soul` は常にグローバル（`SOUL.md` は共通、書き込み先は `data/context/SOUL.md`）
  - `guild_id` は `/^\d+$/` で検証（パストラバーサル防止）
  - 安全策: 上書き前バックアップ、サイズ上限、append-only 日次ログ、SOUL.md は「学んだこと」のみ変更可
- `mcp/event-buffer-server.ts`: イベントバッファ管理ツール（PollingAgent 用）
  - `wait_for_events`: イベントが届くまで待機し、届いたら消費して返す。タイムアウト時は空配列を返す
  - `EVENT_BUFFER_DIR` 環境変数でバッファディレクトリを指定可能（デフォルト: `data/event-buffer/`）
  - ギルド分離時は `data/event-buffer/guilds/{guildId}/events.jsonl` を JSONL 形式で管理
- `mcp/ltm-server.ts`: 長期記憶（LTM）管理ツール — fenghuang ライブラリを使用したエピソード記憶・意味記憶の管理
  - `ltm_ingest`: 会話メッセージを長期記憶に取り込み、閾値到達時にエピソードを自動生成
  - `ltm_retrieve`: クエリに関連する長期記憶をハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で取得
  - `ltm_consolidate`: 未統合のエピソードからファクト（意味記憶）を抽出・統合
  - `ltm_get_facts`: 蓄積されたファクト一覧を取得（カテゴリフィルタ対応）
  - Guild 分離: `data/fenghuang/guilds/{guildId}/memory.db` に SQLite で永続化
  - LLM: `CompositeLLMAdapter`（chat は OpenCode SDK、embed は Ollama）を使用

### 4.5 Composition Root

- `composition-root.ts`: `bootstrap()` — DI 配線のエントリポイント
  - `bootstrapAgents()` に委譲してポーリングモードを起動
  - 全インフラ実装をインスタンス化し、ユースケースに注入してゲートウェイにハンドラをバインド
- `bootstrap-context.ts`: `BootstrapContext` — 各ブートストラップ関数で共有するコンテキスト型
- `bootstrap-helpers.ts`: `createHeartbeat()`, `startSessionGauge()`, `setupShutdown()` — ブートストラップ共有ヘルパー
- `infrastructure/opencode/bootstrap-agents.ts`: `bootstrapAgents()` — エージェントのブートストラップ。ギルドごとに `PollingAgent` + `FileEventBuffer` + `BufferEventUseCase` を生成し、`GuildRoutingAgent` でラップして Heartbeat に渡す。全ギルドのポーリングループを並列起動。

### 4.6 OpenCode 組み込みツール

`PollingAgent` では以下の OpenCode SDK 組み込みツールを有効化している:

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

### MessageChannel

- `sendTyping(): Promise<void>`
- `send(content: string): Promise<void>`

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

### emoji-usage.json 構造

```json
{
	"guildId1": { "pepe_sad": 42, "pepe_happy": 17 },
	"guildId2": { "fire": 5 }
}
```

### sessions.json 構造

```json
{
	"{agentName}:{sessionKey}": "{opencode-session-id}"
}
```

## 6. 主要シーケンス

### 6.1 メッセージルーティング（ポーリングモード）

1. Discord `messageCreate` を受信する。
2. Bot 自身のメッセージのみ除外する。他 Bot メッセージには `isBot` フラグを付与して処理を継続する。
3. メンション → `BufferEventUseCase` でイベントバッファに追加
4. ホームチャンネル（配下スレッド含む） → `BufferEventUseCase` でイベントバッファに追加
5. その他 → 無視
6. AI が `event-buffer` MCP ツールでバッファをポーリングし、自律的に応答を判断・送信する

### 6.4 Heartbeat 自律行動

1. `IntervalHeartbeatScheduler` が 1 分ごとに `tick()` を実行する。
2. `HeartbeatConfigRepository.load()` で設定を読み込む。
3. `evaluateDueReminders()` で due なリマインダーを判定する。
4. due なリマインダーがあれば `HandleHeartbeatUseCase.execute()` を呼ぶ。
5. due リマインダーを guildId でグループ化し、Guild ごとに別セッション `system:heartbeat:{guildId}` で逐次実行する（guildId なしは `system:heartbeat:_autonomous`）。
6. AI が MCP ツール（discord, code-exec, schedule）を使って自律的に行動する。
7. 成功時に `lastExecutedAt` を更新する。

### 6.5 セッション管理（既存）

1. セッションキーで既存セッション ID を検索する。
2. 存在すれば OpenCode API で有効性を検証する。
3. 無効なら新規セッションを作成し、JSON に保存する。
4. 毎回ブートストラップコンテキストを `system` フィールドで送信する（OpenCode はセッション内で system をキャッシュしないため）。

### 6.6 コンテキスト読込

1. 全ファイルはオーバーレイ方式で読み込む: `data/context/` → `context/` の順でフォールバック。
2. 共通ファイル（`IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`）は overlay → base の順。
3. 記憶ファイル（`MEMORY.md`, `LESSONS.md`）は guildId 指定時に `guilds/{guildId}/` → グローバルの順でフォールバック（各段階で overlay → base）。
4. 当日の日次ログも同様に Guild 固有 → グローバルの順（各段階で overlay → base）。
5. 各ファイル 20,000 文字、合計 150,000 文字で切り詰め。
6. XML タグでラップして結合する。
7. guildId が存在する場合、`<guild-context>` タグで guild_id を明示し、MCP ツール使用時の指示を含める。

## 7. 設定

### 必須環境変数

- `DISCORD_TOKEN`: Discord API トークン（`.env` から読込）

### OpenCode プロバイダ設定（PollingAgent 用）

- `OPENCODE_PROVIDER_ID`: プロバイダ ID（デフォルト: `"github-copilot"`）
- `OPENCODE_MODEL_ID`: モデル ID（デフォルト: `"big-pickle"`）

### LTM プロバイダ設定（FenghuangChatAdapter 用）

- `LTM_PROVIDER_ID`: LTM 用プロバイダ ID（フォールバック: `OPENCODE_PROVIDER_ID` → `"github-copilot"`）
- `LTM_MODEL_ID`: LTM 用モデル ID（デフォルト: `"gpt-4o"`）
- `OLLAMA_BASE_URL`: Ollama API エンドポイント（デフォルト: `"http://ollama:11434"`、コンテナ間通信用）
- `LTM_EMBEDDING_MODEL`: 埋め込みモデル（デフォルト: `"embeddinggemma"`）

### Ollama コンテナ

- `compose.yaml` で `ollama` サービスとして定義（`docker.io/ollama/ollama:latest`、CPU 版）
- `bot` → `ollama` のコンテナ間通信は `vicissitude-net` ブリッジネットワーク経由
- モデルデータは `ollama-data` ボリュームに永続化
- 初回起動時に `containers/ollama/entrypoint.sh` が `embeddinggemma` モデルを自動プル（`OLLAMA_MODEL` 環境変数で変更可能）

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

1. Clean Architecture + Ports and Adapters を採用する。
2. DI は手動コンストラクタ注入のみ（Pure DI）。
3. MCP サーバーは独立プロセスとしてレイヤー外に配置する。
4. セッション永続化は JSON ファイルを使用する。
5. コンテキスト運用はオーバーレイ方式で行う: `context/`（git 管理・ベース）に人格定義やデフォルト値を配置し、`data/context/`（gitignore・オーバーレイ）にランタイム記憶やデプロイ固有設定を配置する。読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/` に行う。
6. Guild 跨ぎコンテキスト分離: 人格（IDENTITY, SOUL 等）は共通、記憶（MEMORY, LESSONS, daily log）は Guild ごとに `guilds/{guildId}/` で分離する。DM やフォールバック時はグローバルを使用する。
