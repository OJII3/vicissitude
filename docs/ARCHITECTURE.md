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
- データ: `data/` ディレクトリ（`sessions.json`, `heartbeat-config.json`, `emoji-usage.json`, `context/`）
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
- `response-decision.ts`: `ResponseAction`, `ResponseDecision` — AI 応答判断結果
- `conversation-context.ts`: `ConversationMessage`, `ConversationContext` — 会話履歴
- `emoji-info.ts`: `EmojiInfo` — カスタム絵文字情報（`name`, `identifier`, `animated`）
- `emoji-usage.ts`: `EmojiUsageCount` — カスタム絵文字使用カウント（`emojiName`, `count`）
- `heartbeat-config.ts`: `HeartbeatConfig`, `HeartbeatReminder` (`guildId?` フィールド追加), `DueReminder`, `ReminderSchedule` — Heartbeat 設定

#### ports/

- `ai-agent.port.ts`: `AiAgent` — AI エージェントのインターフェース
  - `send(options: SendOptions): Promise<AgentResponse>` — `SendOptions = { sessionKey, message, guildId? }`
  - `stop(): void`
- `context-loader.port.ts`: `ContextLoader` + `ContextLoaderFactory` — コンテキスト読込
  - `ContextLoader`: `loadBootstrapContext()`
  - `ContextLoaderFactory`: `create(guildId?): ContextLoader` — Guild 単位でローダーを生成
- `logger.port.ts`: `Logger` — ログ出力
  - `info()`, `error()`, `warn()`
- `message-gateway.port.ts`:
  - `IncomingMessage` — 受信メッセージ（`platform`, `channelId`, `guildId?`, `authorId`, `authorName`, `messageId`, `content`, `timestamp`, `isMentioned`, `isThread`, `reply()`, `react()`）
  - `MessageChannel` — チャンネル操作（`sendTyping()`, `send()`)
  - `MessageGateway` — ゲートウェイ（`onMessage()`, `onHomeChannelMessage()`, `start()`, `stop()`)
- `channel-config-loader.port.ts`: `ChannelConfigLoader` — チャンネル設定読込
  - `getRole(channelId)`, `getCooldown(channelId)`
- `emoji-provider.port.ts`: `EmojiProvider` — ギルドカスタム絵文字取得
  - `getGuildEmojis(guildId): Promise<EmojiInfo[]>`
- `emoji-usage-tracker.port.ts`: `EmojiUsageTracker` — カスタム絵文字使用頻度トラッキング
  - `increment(guildId, emojiName)`, `getTopEmojis(guildId, limit)`, `hasData(guildId)`
- `response-judge.port.ts`: `ResponseJudge` — AI 応答判断
  - `judge(message, context, availableEmojis?): Promise<ResponseDecision>`
- `conversation-history.port.ts`: `ConversationHistory` — 会話履歴取得
  - `getRecent(channelId, limit, excludeMessageId?): Promise<ConversationContext>`
- `session-repository.port.ts`: `SessionRepository` — セッション永続化
  - `get()`, `save()`, `exists()`
- `heartbeat-config-repository.port.ts`: `HeartbeatConfigRepository` — Heartbeat 設定永続化
  - `load()`, `save()`, `updateLastExecuted()`

#### services/

- `message-formatter.ts`: `splitMessage()` — 2000 文字制限でのメッセージ分割（純粋関数）
- `cooldown-tracker.ts`: `CooldownTracker` — チャンネルごとの応答クールダウン管理
- `emoji-ranking.ts`: `filterTopEmojis()` — 使用頻度トップの絵文字でフィルタリング（純粋関数）
- `heartbeat-evaluator.ts`: `evaluateDueReminders()` — Heartbeat 設定から due なリマインダーを判定（純粋関数）

### 4.2 Application 層 — ユースケース

- `handle-incoming-message.use-case.ts`: `HandleIncomingMessageUseCase`
  - 依存: `AiAgent`, `Logger`
  - 処理: メッセージ受信 → typing 開始 → AI 送信 → 応答分割 → 返信/送信
  - 用途: メンション/スレッド（必ず応答）
- `handle-home-channel-message.use-case.ts`: `HandleHomeChannelMessageUseCase`
  - 依存: `AiAgent`, `ResponseJudge`, `ConversationHistory`, `ChannelConfigLoader`, `CooldownTracker`, `EmojiProvider`, `EmojiUsageTracker`, `Logger`
  - 処理: クールダウン確認 → 会話履歴取得 → カスタム絵文字取得 → 人気順フィルタリング → AI 判断 → respond/react/ignore
  - 用途: ホームチャンネル（自律参加）
- `handle-heartbeat.use-case.ts`: `HandleHeartbeatUseCase`
  - 依存: `AiAgent`, `HeartbeatConfigRepository`, `Logger`
  - 処理: due リマインダーからプロンプト構築 → AI セッション起動 → lastExecutedAt 更新
  - 用途: Heartbeat 自律行動

### 4.3 Infrastructure 層 — ポートの具象実装

- `discord/discord-gateway.ts`: `DiscordGateway implements MessageGateway`
  - discord.js Client でメッセージ受信
  - ルーティング: メンション/スレッド → onMessage、ホームチャンネル → onHomeChannelMessage、それ以外 → 無視
  - メンション文字列 (`<@!?\d+>`) を除去
  - `onEmojiUsed(handler)`: カスタム絵文字使用イベントのハンドラ登録（具象メソッド、ポート外）
  - `messageCreate` 内でカスタム絵文字（`<:name:id>` / `<a:name:id>`）を正規表現で検出してハンドラ呼び出し
  - `MessageReactionAdd` イベントを購読し、カスタム絵文字リアクションでハンドラ呼び出し
  - `Partials.Reaction`, `Partials.Message`, `Partials.Channel` を有効化（キャッシュ外メッセージへのリアクション受信に必要）
- `discord/discord-conversation-history.ts`: `DiscordConversationHistory implements ConversationHistory`
  - discord.js で直近メッセージを fetch
- `discord/discord-emoji-provider.ts`: `DiscordEmojiProvider implements EmojiProvider`
  - `guild.emojis.cache` からカスタム絵文字一覧を取得（キャッシュのみ参照）
- `opencode/opencode-agent.ts`: `OpencodeAgent implements AiAgent`
  - OpenCode SDK でセッション管理・メッセージ送信
  - 毎回 system prompt でブートストラップコンテキストを注入
- `opencode/mcp-config.ts`: `mcpServerConfigs()` — MCP サーバー設定
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
- `opencode/opencode-response-judge.ts`: `OpencodeResponseJudge implements ResponseJudge`
  - 専用の `OpencodeJudgeAgent` を使用（MCP ツールなし、毎回新規セッション）
  - AI にメッセージへの応答判断を委譲（respond/react/ignore）
- `persistence/json-emoji-usage-repository.ts`: `JsonEmojiUsageRepository implements EmojiUsageTracker`
  - `data/emoji-usage.json` に絵文字使用カウントを永続化
  - インメモリキャッシュ + 30 秒遅延フラッシュ（graceful shutdown 時は即時フラッシュ）
- `persistence/json-heartbeat-config-repository.ts`: `JsonHeartbeatConfigRepository implements HeartbeatConfigRepository`
  - `data/heartbeat-config.json` に設定を永続化
  - ファイル不在時はデフォルト設定を返す
- `scheduler/interval-heartbeat-scheduler.ts`: `IntervalHeartbeatScheduler`
  - 1分間隔の `setInterval` ループ
  - `running` フラグで重複実行を防止
- `logging/console-logger.ts`: `ConsoleLogger implements Logger`

### 4.4 MCP サーバー（独立プロセス、レイヤー外）

- `mcp/discord-server.ts`: Discord 操作ツール
  - `send_message`, `reply`, `add_reaction`, `read_messages`, `list_channels`
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

### 4.5 Composition Root

- `composition-root.ts`: `bootstrap()` — 唯一の DI 配線場所
  - 全インフラ実装をインスタンス化
  - ユースケースに注入
  - ゲートウェイにハンドラをバインドして起動

## 5. データモデル

### AgentResponse

- `text: string`
- `sessionId: string`

### SessionKey

- ユーザー単位: `{platform}:{channelId}:{authorId}` (例: `discord:123456:789012`)
- チャンネル単位: `{platform}:{channelId}:_channel` (例: `discord:123456:_channel`)

### IncomingMessage

- `platform: string` — プラットフォーム識別子
- `channelId: string`
- `guildId?: string` — Guild ID（DM 時は undefined）
- `authorId: string`
- `authorName: string`
- `messageId: string`
- `content: string`
- `timestamp: Date` — メッセージ作成時刻
- `isMentioned: boolean`
- `isThread: boolean`
- `reply(text: string): Promise<void>`
- `react(emoji: string): Promise<void>`

### channels.json 構造

```json
{
	"defaultCooldownSeconds": 120,
	"channels": [{ "channelId": "...", "role": "home", "cooldownSeconds": 60 }]
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

### 6.1 メッセージルーティング

1. Discord `messageCreate` を受信する。
2. Bot 自身のメッセージを除外する。
3. メンション → `HandleIncomingMessageUseCase`（必ず応答）
4. ホームチャンネル（配下スレッド含む） → `HandleHomeChannelMessageUseCase`（自律判断）
5. その他 → 無視

### 6.2 メンション応答（従来フロー）

1. メンション文字列を除去し `IncomingMessage` に変換する。
2. 空メッセージなら早期リターンする。
3. ユーザー単位セッションキーを生成する。
4. typing インジケーターを 8 秒間隔で開始する。
5. `AiAgent.send()` で AI に送信する。
6. 応答を `splitMessage()` で 2000 文字以内に分割する。
7. 最初のチャンクを `reply()` で、以降を `send()` で送信する。

### 6.3 ホームチャンネル応答（新フロー）

1. 空メッセージ → スキップ
2. クールダウン中 → スキップ
3. `ConversationHistory.getRecent()` で直近 10 件取得
4. `EmojiProvider.getGuildEmojis()` でギルドカスタム絵文字取得（失敗時は無視して続行）
5. `EmojiUsageTracker` で使用頻度トップ 20 にフィルタリング（コールドスタート時は全絵文字にフォールバック）
6. `ResponseJudge.judge()` で AI 判断（フィルタ済み絵文字一覧をプロンプトに含める）
7. `ignore` → 何もしない
8. `react` → カスタム絵文字の `:name:` を ID に解決し `msg.react()` してクールダウン記録（解決にはフィルタ前の全絵文字を使用）
9. `respond` → チャンネル単位セッションで `agent.send()` し、`channel.send()` で送信、クールダウン記録

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

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- データディレクトリ: `{project-root}/data/`
- コンテキストディレクトリ: `{project-root}/context/`（ベース）、`{project-root}/data/context/`（オーバーレイ、読み込み優先）

## 8. エラーハンドリング

- AI 呼び出し失敗（メンション/スレッド）: 汎用エラーメッセージを reply で返信し、詳細はログのみに記録する。
- AI 呼び出し失敗（ホームチャンネル）: ログに記録するのみ（ユーザーへのフィードバックなし）。
- judge 失敗: 安全側（ignore）にフォールバックし、ログに記録する。
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
