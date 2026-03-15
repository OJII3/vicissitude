# Vicissitude

AIキャラクター「ふあ」

TypeScript + Bun で動作し、OpenCode を推論エンジンとして使用する。

## コンセプト

そこで生きているかような自然な存在、AITuber もどきを作る。ただし、特段バーチャルにこだわらない。当面はDiscordが本拠地。

## 1. 目的

最重要目標は次の 3 点の両立

1. 自然に雑談できる。感情を持ち、怒ったり喜んだり、空気を読んで無視したりできる。
2. チャットコミュニケーションを保ちながら、チャット外で自立行動できる(e.g. Minecraftをプレイ)。
3. 情報過多でエージェントがパンクしない。マルチエージェントやツールを駆使して、コンテキストやタスクを適切に分割・管理する。

## 2. 対象ユーザー

- 開発者本人
- 開発者の身内コミュニティ

## 3. プロダクト要件

### 3.1 会話参加

- 全メッセージはイベントバッファに追加され、AI が `event-buffer` MCP ツールでポーリングして自律的に応答を判断・送信する。
- Bot 自身のメッセージには反応しない。
- 他 Bot からのメッセージには `isBot` フラグを付与し、AI が応答判断する。
- メッセージに画像添付（`image/png`, `image/jpeg`, `image/gif`, `image/webp`）がある場合、AI に画像を認識させる。
  - テキストが空でも画像添付があれば処理を続行する。

### 3.2 AI エージェント

- 推論は OpenCode SDK 経由で行う。基本的に GitHub Copilot プロバイダを使用。
- メインの人格、チャットは claude モデルを使用する。(性格が好みのため)
- GitHub Copilot へのプロンプト送信回数を減らすため、 `promptAsync()` で長寿命ポーリングプロンプトを送信し、エージェント自身が `wait_for_event` ツールでイベントを待ち受ける方式を採用する。
- Discord ではギルドごとに独立した `AgentRunner` セッションを持つ。各セッションは初回イベントで起動し、終了イベント（idle/error/cancelled など）を監視して必要時のみ再起動する。
- セッション ID は SQLite で永続化する。

### 3.3 ツール構成

#### MCP サーバー

OpenCode が使用する MCP サーバーを提供する。

1. **discord**: Discord チャンネルへの読み書き
   - `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`（画像 URL をメッセージに含む）, `list_channels`
   - `send_message` / `reply` はオプションで画像ファイルパス（`file_path`）を受け取り、添付ファイルとして送信可能
2. **code-exec**: コード実行
   - `execute_code` (JavaScript, TypeScript, Python, Shell)
3. **schedule**: Heartbeat スケジュール管理
   - `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
4. **memory**: メモリ・人格の自己更新
   - `read_memory`, `update_memory`: MEMORY.md の読み書き
   - `read_soul`: SOUL.md の読み取り
   - `append_daily_log`, `read_daily_log`, `list_daily_logs`: 日次ログ管理
   - `read_lessons`, `update_lessons`: LESSONS.md の読み書き
5. **ltm**: 長期記憶（src/ltm/）
   - 会話メッセージの取り込み（ingestion）はメインプロセスで自動化（ホームチャンネルのメッセージのみ、bot 自身の発言を含む）
   - `ltm_retrieve`: ハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で関連記憶を取得
   - `ltm_get_facts`: 蓄積されたファクト一覧を取得
   - consolidation はメインプロセスの `ConsolidationScheduler` が30分間隔で自動実行
6. **MC ブリッジ**（core-server 内、Discord 側）: Minecraft エージェントとの通信
   - `minecraft_delegate`, `minecraft_status`, `minecraft_read_reports`, `minecraft_start_session`, `minecraft_stop_session`
7. **minecraft**（`MC_HOST` 設定時のみ有効）: Minecraft 操作（mineflayer ベース）
   - `observe_state`: 現在状態の要約を取得
   - `get_recent_events`: 直近重要イベント取得
   - `follow_player`: 指定プレイヤーへ追従
   - `go_to`: 指定地点へ移動
   - `collect_block`: 指定ブロックを採集
   - `stop`: 現在の移動・追従を停止
   - `get_job_status`: ジョブ状態・履歴取得
   - `get_viewer_url`: Minecraft ビューアーの URL を返す
   - `craft_item`: 指定アイテムをクラフト
   - `place_block`: 指定ブロックを設置
   - `equip_item`: アイテム装備
   - `sleep_in_bed`: 就寝を試行
   - `send_chat`: Minecraft 内チャット送信
   - `eat_food`: 食料を食べる
   - `flee_from_entity`: 指定エンティティから逃走
   - `find_shelter`: 安全な避難場所を探す
8. **mc-bridge**（`MC_HOST` 設定時のみ有効）: Minecraft エージェント専用 MCP サーバー
   - Minecraft 側ブリッジ: `mc_report`, `mc_read_commands`
   - メモリツール: `mc_read_goals`, `mc_update_goals`, `mc_read_skills`, `mc_record_skill`, `mc_read_progress`, `mc_update_progress`

#### OpenCode SDK 組み込みツール

- `webfetch`: 指定 URL の内容を取得
- `websearch`: Web 検索を実行

### 3.4 コンテキスト運用

- オーバーレイ方式でコンテキストを管理する: `context/`（git 管理・ベース）に人格定義やデフォルト値を配置し、`data/context/`（gitignore・オーバーレイ）にランタイム記憶やデプロイ固有設定を配置する。読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/` に行う。
- 静的ファイル: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`, `MEMORY.md`, `LESSONS.md`
- チャンネル設定: `channels.json`（ホームチャンネル一覧、guildId、guildName・channelName（人間用ラベル）、クールダウン設定）
- 日次ログ: `memory/{YYYY-MM-DD}.md`
- ファイル毎最大 20,000 文字、合計最大 150,000 文字。
- **LTM ファクト注入**: `loadBootstrapContext()` 時に LTM（src/ltm/）から蓄積済みファクト（SemanticFact）を読み取り、`<ltm-facts>` セクションとしてシステムプロンプトに注入する。これにより AI は過去の会話から抽出された意味記憶（ユーザー情報、関係性、嗜好等）を常時参照できる。

### 3.5 Guild 跨ぎコンテキスト分離

- 人格共通: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md` は全 Guild で共有。
- 記憶分離: `MEMORY.md`, `LESSONS.md`, 日次ログ (`memory/`) は Guild ごとに `guilds/{guildId}/` で分離（オーバーレイ方式で `data/context/` → `context/` のフォールバック）。
- LTM も Guild ごとに `data/ltm/guilds/{guildId}/memory.db` で分離。
- DM やフォールバック時はグローバルを使用。
- MCP memory ツールでは `guild_id` パラメータで Guild 固有メモリにアクセス。
- Guild 間で会話内容・メンバー情報・教訓が漏洩しない。

### 3.6 記憶システムの責務分離

ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）と LTM（Episodes, SemanticFacts）を併用し、情報の種類に応じて担当を分離する。

| 情報の種類                         | 担当システム     | 保持期間       | 備考                                        |
| ---------------------------------- | ---------------- | -------------- | ------------------------------------------- |
| ユーザー情報（名前、特徴、関係性） | LTM SemanticFact | 永続           | 会話から自動抽出                            |
| メンバーの性格・好み               | LTM SemanticFact | 永続           | 会話から自動抽出                            |
| 会話内容の要約                     | LTM Episodes     | 永続           | 会話から自動生成                            |
| 個別の行動ガイドライン             | LTM guideline    | 永続           | 会話から自動抽出。状況固有                  |
| チャンネル設定メモ                 | MEMORY.md        | 永続           | 運用固有、自動抽出不適                      |
| 行動ルール                         | MEMORY.md        | 永続           | AI の自己指示、構造化が必要                 |
| 週次目標・運用メモ                 | MEMORY.md        | 永続           | 時限的、手動管理が適切                      |
| 運用ルール                         | MEMORY.md        | 永続           | 開発者が設定する行動指示                    |
| 精選教訓（原則）                   | LESSONS.md       | 永続           | AI が複数経験から一般化。手動キュレーション |
| Heartbeat 実行ログ                 | 日次ログ         | 7 日           | 時系列の実行記録。古いものは自動削除        |
| 会話中の自省・気づき               | 日次ログ → LTM   | 日次ログ: 7 日 | 重要なものは consolidate で LTM に移行      |

日次ログの保持期間（7 日）は `memory` MCP ツールの `cleanup_old_logs` で実装する。

### 3.7 エラー応答

- AI 呼び出し失敗時は、エラーメッセージを reply で返す。
- 失敗内容はログに記録する。

### 3.8 Minecraft 連携方針

- 既存の OpenCode + MCP + memory 構成は置き換えない。
- Minecraft 連携は `minecraft` MCP サーバーで実現する。
- 低レベル操作（移動、採集、クラフト等）は mineflayer に委譲し、LLM は高レベル判断に集中する。
- 外向き人格は Discord 雑談人格に統一し、内部実装事情を直接露出しない。

### 3.9 コンテキスト過負荷の防止

- 毎 tick の生状態を LLM に渡さない（座標列、視界詳細、長大ログは直接投入しない）。
- LLM へは要約済み状態のみ渡す（位置概要、体力/空腹、昼夜、近傍危険、重要インベントリ、現在目標、直近重要イベント）。
- 意思決定はイベント駆動を基本とし、状態変化や失敗時に再判断する。

### 3.10 Minecraft ビューアー

- `prismarine-viewer` を HTTP サーバーとして起動し、ブラウザベースのビューアーを提供する。
- `get_viewer_url` ツールでビューアー URL を取得し、Discord で共有可能にする。

### 3.11 Minecraft エージェント

- Discord 側とは独立した AgentRunner で動作する Minecraft 専用エージェント。
- 30秒間隔のポーリングループで自律行動。危険回避（P0-P1）、基本行動（P2）、目標管理（P3）の優先度で判断。
- Discord 側↔Minecraft エージェント間は SQLite ベースの Event Bridge（`mc_bridge_events` テーブル）で通信。
- Minecraft エージェントの記憶（`MINECRAFT-GOALS.md`, `MINECRAFT-SKILLS.md`）は Guild 非依存のグローバルオーバーレイ方式。
- `minecraft_start_session` / `minecraft_stop_session` で Discord 側からライフサイクルを制御。

#### 3.11.1 責務

- 単一の Minecraft `AgentRunner` が判断を担う。
- `observe_state` / `get_recent_events` / `get_job_status` を用いて状況を要約し、低レベル MCP ツール呼び出しへ落とし込む。
- Discord からの依頼受付、Minecraft 側の自律行動、進捗記録、報告判断は同一エージェント内で処理する。

#### 3.11.2 実行安全性ルール

- 危険イベント（`death`, `kicked`, `disconnect`, `damage`, 高重要度 hostile 接近）は、平常時の目標駆動判断より優先する。
- 危険時は進行中ジョブを継続せず、まず `stop` で現在行動を中断し、再観測のうえで最も危険を減らす 1 手だけを選ぶ。
- 危険時の候補アクションは `eat_food`, `flee_from_entity`, `find_shelter`, `sleep_in_bed` とし、固定順ではなく状況依存で選択する。
- 危険時は詳細な複数手計画よりも「直近の生存リスクを下げる次の一手」を優先する。
- 平常時の判断ループと、危険時の短い即応判断ループを分けて扱う。危険時ループでは長い計画立案や採集・探索を開始しない。
- `get_job_status` で失敗またはキャンセルが連続した同系統ジョブは、その場で即再試行せずクールダウン対象とする。
- 再試行は「前提条件が変わった」と説明できる場合に限定する。例: 体力回復、食料補充、夜明け、対象再発見。
- Discord からの通常依頼は危険回避より下位とし、緊急回避中は延期または中断報告を返してよい。
- Discord 通知は即時自動通知と LLM 判断通知に分類する。
  - 即時自動通知（`AutoNotifier`）: `death`, `kicked`, `disconnect` — ブリッジ DB に自動挿入。同一種別 30 秒クールダウンで重複抑制。
  - LLM 判断通知（`mc_report`）: 依頼失敗、危険回避開始/失敗/完了、再計画開始、依頼延期、長時間スタック — LLM が状況を判断して送信。
- stuck 検知: `JobManager` が以下の (A∨B)∧C で stuck 状態を判定し、`observe_state` にスタック警告として表示する。LLM が認識して `mc_report` で Discord 報告 + `mc_update_goals` で目標見直しを行う（自動通知はしない）。
  - A: 直近 4 件のジョブが同一タイプですべて `failed`
  - B: 過去 3 回の位置スナップショットの総移動距離 < 3 ブロック、かつ idle 状態
  - C: 最後の成功ジョブから 5 分以上経過
  - stuck イベント発行時に `mc_stuck_total` メトリクスをカウント。成功ジョブで stuck 通知フラグをリセットし、重複通知を防止する。
- 危険時の即応は既存ツールを使う標準手順として定義し、新たな自動戦闘ロジックや常駐監視プロセスは追加しない。

## 4. 非機能要件

- 実行環境はローカル常駐（Bun ランタイム）。
- 秘密情報（トークンなど）はログに平文出力しない。

## 5. 設定要件

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- `OPENCODE_MODEL_ID`: AI モデル ID（デフォルト: `big-pickle`）
- `MC_PROVIDER_ID`: Minecraft エージェント用プロバイダ ID（省略時は `OPENCODE_PROVIDER_ID` にフォールバック）
- `MC_MODEL_ID`: Minecraft エージェント用モデル ID（省略時は `OPENCODE_MODEL_ID` にフォールバック）

## 6. 受け入れ条件

1. Bot メンションで AI 応答が返る。
2. Bot 自身のメッセージには反応しない。
3. セッション管理が永続化され、再起動後も継続できる。
4. ブートストラップコンテキストが毎回 system prompt として注入される。
5. MCP サーバー経由で Discord 操作・コード実行が可能。
6. AI がイベントバッファをポーリングし、自律的に応答を判断・送信する。
7. `minecraft` MCP サーバー経由で、接続・状態取得・追従/移動・基本採集の最小フローが動作する。
8. AI が Minecraft 状況を簡潔に要約して Discord 上で説明できる。
