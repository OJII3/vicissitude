# SPEC.md

## 1. 目的

Vicissitude は、身内向け Discord サーバーで雑談に自然参加する Bot を作るプロジェクトである。
人格名は「ふあ」とし、OpenCode + MCP を推論エンジンとして使用する。

## 2. 対象ユーザー

- 開発者本人
- 開発者の身内コミュニティ

多少の粗さや不完全さは許容する。

## 3. プロダクト要件（MVP）

### 3.1 会話参加

- 全メッセージは `BufferEventUseCase` でイベントバッファに追加され、AI が `event-buffer` MCP ツールでポーリングして自律的に応答を判断・送信する。
- Bot 自身のメッセージには反応しない。
- 他 Bot からのメッセージには `isBot` フラグを付与し、AI が応答判断する。
- メッセージに画像添付（`image/png`, `image/jpeg`, `image/gif`, `image/webp`）がある場合、AI に画像を認識させる。
  - テキストが空でも画像添付があれば処理を続行する。

### 3.2 AI エージェント

- 推論は OpenCode SDK 経由で行う。GitHub Copilot プロバイダを使用。
- モデルは `github-copilot:claude-sonnet-4.6` を使用する。
- AI には `promptAsync()` でポーリングプロンプトを送信し、1 セッションで全イベントを処理する。
- ギルドごとに独立した `PollingAgent` セッションを持つ。
- セッション ID は JSON ファイルで永続化する。

### 3.3 ツール構成

#### MCP サーバー

OpenCode が使用する MCP サーバーを提供する。

1. **discord**: Discord チャンネルへの読み書き
   - `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`（画像 URL をメッセージに含む）, `list_channels`
2. **code-exec**: コード実行
   - `execute_code` (JavaScript, TypeScript, Python, Shell)
3. **schedule**: Heartbeat スケジュール管理
   - `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
4. **memory**: メモリ・人格の自己更新
   - `read_memory`, `update_memory`: MEMORY.md の読み書き
   - `read_soul`, `evolve_soul`: SOUL.md の読み取り・「学んだこと」への追記
   - `append_daily_log`, `read_daily_log`, `list_daily_logs`: 日次ログ管理
   - `read_lessons`, `update_lessons`: LESSONS.md の読み書き
5. **ltm**: 長期記憶（fenghuang ベース）
   - `ltm_ingest`: 会話メッセージを取り込み、エピソード記憶を自動生成
   - `ltm_retrieve`: ハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で関連記憶を取得
   - `ltm_consolidate`: エピソードからファクト（意味記憶）を抽出・統合
   - `ltm_get_facts`: 蓄積されたファクト一覧を取得

#### OpenCode SDK 組み込みツール

- `webfetch`: 指定 URL の内容を取得
- `websearch`: Web 検索を実行

### 3.4 コンテキスト運用

- オーバーレイ方式でコンテキストを管理する: `context/`（git 管理・ベース）に人格定義やデフォルト値を配置し、`data/context/`（gitignore・オーバーレイ）にランタイム記憶やデプロイ固有設定を配置する。読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/` に行う。
- 静的ファイル: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`, `MEMORY.md`, `LESSONS.md`
- チャンネル設定: `channels.json`（ホームチャンネル一覧、guildId、guildName・channelName（人間用ラベル）、クールダウン設定）
- 日次ログ: `memory/{YYYY-MM-DD}.md`
- ファイル毎最大 20,000 文字、合計最大 150,000 文字。

### 3.5 Guild 跨ぎコンテキスト分離

- 人格共通: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md` は全 Guild で共有。
- 記憶分離: `MEMORY.md`, `LESSONS.md`, 日次ログ (`memory/`) は Guild ごとに `guilds/{guildId}/` で分離（オーバーレイ方式で `data/context/` → `context/` のフォールバック）。
- DM やフォールバック時はグローバルを使用。
- MCP memory ツールでは `guild_id` パラメータで Guild 固有メモリにアクセス。
- Guild 間で会話内容・メンバー情報・教訓が漏洩しない。

### 3.6 エラー応答

- AI 呼び出し失敗時は、エラーメッセージを reply で返す。
- 失敗内容はログに記録する。

## 4. 非機能要件

- 初期の実行環境はローカル常駐（Bun ランタイム）とする。
- 明示的な性能 SLA は当面設けない。
- 秘密情報（トークンなど）はログに平文出力しない。

## 5. 設定要件

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- `OPENCODE_MODEL_ID`: AI モデル ID（デフォルト: `big-pickle`）

## 6. 受け入れ条件

1. Bot メンションで AI 応答が返る。
2. Bot 自身のメッセージには反応しない。
3. セッション管理が永続化され、再起動後も継続できる。
4. ブートストラップコンテキストが毎回 system prompt として注入される。
5. MCP サーバー経由で Discord 操作・コード実行が可能。
6. AI がイベントバッファをポーリングし、自律的に応答を判断・送信する。
