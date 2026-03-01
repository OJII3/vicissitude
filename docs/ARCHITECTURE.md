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
- コンテキスト: `context/` ディレクトリ（`IDENTITY.md`, `SOUL.md` 等）
- データ: `data/` ディレクトリ（`sessions.json`）
- 外部依存:
  - Discord API (`discord.js`)
  - OpenCode SDK (`@opencode-ai/sdk`)
  - MCP SDK (`@modelcontextprotocol/sdk`)

## 4. レイヤー構成

### 4.1 Domain 層 — 純粋 TS、外部依存なし

#### entities/

- `agent-response.ts`: `AgentResponse` — AI 応答の型定義
  - `text: string` — 応答テキスト
- `session.ts`: `SessionKey` 型 + `createSessionKey()` / `createChannelSessionKey()` — セッションキー生成
  - ユーザー単位: `{platform}:{channelId}:{authorId}`
  - チャンネル単位: `{platform}:{channelId}:_channel`
- `channel-config.ts`: `ChannelRole`, `ChannelConfig` — チャンネル設定
- `response-decision.ts`: `ResponseAction`, `ResponseDecision` — AI 応答判断結果
- `conversation-context.ts`: `ConversationMessage`, `ConversationContext` — 会話履歴

#### ports/

- `ai-agent.port.ts`: `AiAgent` — AI エージェントのインターフェース
  - `send(sessionKey, message): Promise<AgentResponse>`
  - `stop(): void`
- `context-loader.port.ts`: `ContextLoader` — コンテキスト読込
  - `loadBootstrapContext(): Promise<string>`
  - `wrapWithContext(message): Promise<string>`
- `logger.port.ts`: `Logger` — ログ出力
  - `info()`, `error()`, `warn()`
- `message-gateway.port.ts`:
  - `IncomingMessage` — 受信メッセージ（`channelId`, `authorId`, `authorName`, `messageId`, `content`, `isMentioned`, `isThread`, `reply()`, `react()`)
  - `MessageChannel` — チャンネル操作（`sendTyping()`, `send()`)
  - `MessageGateway` — ゲートウェイ（`onMessage()`, `onHomeChannelMessage()`, `start()`, `stop()`)
- `channel-config-loader.port.ts`: `ChannelConfigLoader` — チャンネル設定読込
  - `getRole(channelId)`, `getCooldown(channelId)`
- `response-judge.port.ts`: `ResponseJudge` — AI 応答判断
  - `judge(message, context): Promise<ResponseDecision>`
- `conversation-history.port.ts`: `ConversationHistory` — 会話履歴取得
  - `getRecent(channelId, limit): Promise<ConversationContext>`
- `session-repository.port.ts`: `SessionRepository` — セッション永続化
  - `get()`, `save()`, `exists()`

#### services/

- `message-formatter.ts`: `splitMessage()` — 2000 文字制限でのメッセージ分割（純粋関数）
- `cooldown-tracker.ts`: `CooldownTracker` — チャンネルごとの応答クールダウン管理

### 4.2 Application 層 — ユースケース

- `handle-incoming-message.use-case.ts`: `HandleIncomingMessageUseCase`
  - 依存: `AiAgent`, `Logger`
  - 処理: メッセージ受信 → typing 開始 → AI 送信 → 応答分割 → 返信/送信
  - 用途: メンション/スレッド（必ず応答）
- `handle-home-channel-message.use-case.ts`: `HandleHomeChannelMessageUseCase`
  - 依存: `AiAgent`, `ResponseJudge`, `ConversationHistory`, `ChannelConfigLoader`, `CooldownTracker`, `Logger`
  - 処理: クールダウン確認 → 会話履歴取得 → AI 判断 → respond/react/ignore
  - 用途: ホームチャンネル（自律参加）

### 4.3 Infrastructure 層 — ポートの具象実装

- `discord/discord-gateway.ts`: `DiscordGateway implements MessageGateway`
  - discord.js Client でメッセージ受信
  - ルーティング: メンション/スレッド → onMessage、ホームチャンネル → onHomeChannelMessage、それ以外 → 無視
  - メンション文字列 (`<@!?\d+>`) を除去
- `discord/discord-conversation-history.ts`: `DiscordConversationHistory implements ConversationHistory`
  - discord.js で直近メッセージを fetch
- `opencode/opencode-agent.ts`: `OpencodeAgent implements AiAgent`
  - OpenCode SDK でセッション管理・メッセージ送信
  - 初回セッション時にコンテキスト注入
- `opencode/mcp-config.ts`: `mcpServerConfigs()` — MCP サーバー設定
- `persistence/json-session-repository.ts`: `JsonSessionRepository implements SessionRepository`
  - `data/sessions.json` にセッション ID を永続化
  - インメモリキャッシュ + lazy load
- `context/file-context-loader.ts`: `FileContextLoader implements ContextLoader`
  - `context/` 配下の Markdown ファイルを読込・結合
- `context/json-channel-config-loader.ts`: `JsonChannelConfigLoader implements ChannelConfigLoader`
  - `context/channels.json` からチャンネル設定を読込
- `opencode/opencode-response-judge.ts`: `OpencodeResponseJudge implements ResponseJudge`
  - AI にメッセージへの応答判断を委譲（respond/react/ignore）
- `logging/console-logger.ts`: `ConsoleLogger implements Logger`

### 4.4 MCP サーバー（独立プロセス、レイヤー外）

- `mcp/discord-server.ts`: Discord 操作ツール
  - `send_message`, `reply`, `add_reaction`, `read_messages`, `list_channels`
- `mcp/code-exec-server.ts`: コード実行ツール
  - `execute_code` (JS/TS/Python/Shell)
  - tmux で実行、10 秒タイムアウト

### 4.5 Composition Root

- `composition-root.ts`: `bootstrap()` — 唯一の DI 配線場所
  - 全インフラ実装をインスタンス化
  - ユースケースに注入
  - ゲートウェイにハンドラをバインドして起動

## 5. データモデル

### AgentResponse

- `text: string`

### SessionKey

- ユーザー単位: `{platform}:{channelId}:{authorId}` (例: `discord:123456:789012`)
- チャンネル単位: `{platform}:{channelId}:_channel` (例: `discord:123456:_channel`)

### IncomingMessage

- `channelId: string`
- `authorId: string`
- `authorName: string`
- `messageId: string`
- `content: string`
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
3. メンション/スレッド → `HandleIncomingMessageUseCase`（必ず応答）
4. ホームチャンネル → `HandleHomeChannelMessageUseCase`（自律判断）
5. その他 → 無視

### 6.2 メンション/スレッド応答（従来フロー）

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
4. `ResponseJudge.judge()` で AI 判断
5. `ignore` → 何もしない
6. `react` → `msg.react(emoji)` してクールダウン記録
7. `respond` → チャンネル単位セッションで `agent.send()` し、`channel.send()` で送信、クールダウン記録

### 6.4 セッション管理

1. セッションキーで既存セッション ID を検索する。
2. 存在すれば OpenCode API で有効性を検証する。
3. 無効なら新規セッションを作成し、JSON に保存する。
4. 初回セッションならコンテキストをラップして送信する。

### 6.5 コンテキスト読込

1. `IDENTITY.md` → `SOUL.md` → `AGENTS.md` → `TOOLS.md` → `USER.md` → `MEMORY.md` の順で読込。
2. 当日の `memory/{YYYY-MM-DD}.md` があれば追加。
3. 各ファイル 20,000 文字、合計 150,000 文字で切り詰め。
4. XML タグでラップして結合する。

## 7. 設定

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- データディレクトリ: `{project-root}/data/`
- コンテキストディレクトリ: `{project-root}/context/`

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
5. コンテキスト運用は `context/` ディレクトリの Markdown ファイルで行う。
