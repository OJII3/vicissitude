# SPEC.md

## 1. 目的

Vicissitude は、身内向け Discord サーバーで雑談に自然参加する Bot を中核としつつ、Minecraft 上での基本行動を追加するプロジェクトである。
人格名は「ふあ」とし、OpenCode + MCP を推論エンジンとして使用する。

最重要目標は次の 3 点の両立:

1. Discord 上で自然に雑談できる
2. Minecraft 上で簡単な自律行動ができる
3. 情報過多でエージェントがパンクしない

## 2. 対象ユーザー

- 開発者本人
- 開発者の身内コミュニティ

多少の粗さや不完全さは許容する。

## 3. プロダクト要件（MVP）

### 3.1 会話参加

- 全メッセージはイベントバッファに追加され、AI が `event-buffer` MCP ツールでポーリングして自律的に応答を判断・送信する。
- Bot 自身のメッセージには反応しない。
- 他 Bot からのメッセージには `isBot` フラグを付与し、AI が応答判断する。
- メッセージに画像添付（`image/png`, `image/jpeg`, `image/gif`, `image/webp`）がある場合、AI に画像を認識させる。
  - テキストが空でも画像添付があれば処理を続行する。

### 3.2 AI エージェント

- 推論は OpenCode SDK 経由で行う。GitHub Copilot プロバイダを使用。
- モデルは `github-copilot:claude-sonnet-4.6` を使用する。
- AI には `promptAsync()` でポーリングプロンプトを送信し、1 セッションで全イベントを処理する。
- ギルドごとに独立した `AgentRunner` セッションを持つ。
- セッション ID は SQLite で永続化する。

### 3.3 ツール構成

#### MCP サーバー

OpenCode が使用する MCP サーバーを提供する。

1. **discord**: Discord チャンネルへの読み書き
   - `send_typing`, `send_message`, `reply`, `add_reaction`, `read_messages`（画像 URL をメッセージに含む）, `list_channels`
   - `send_message` / `reply` はオプションで画像ファイルパス（`file_path`）を受け取り、添付ファイルとして送信可能（実装済み）
2. **code-exec**: コード実行
   - `execute_code` (JavaScript, TypeScript, Python, Shell)
3. **schedule**: Heartbeat スケジュール管理
   - `get_heartbeat_config`, `list_reminders`, `add_reminder`, `update_reminder`, `remove_reminder`, `set_base_interval`
4. **memory**: メモリ・人格の自己更新
   - `read_memory`, `update_memory`: MEMORY.md の読み書き
   - `read_soul`: SOUL.md の読み取り
   - `append_daily_log`, `read_daily_log`, `list_daily_logs`: 日次ログ管理
   - `read_lessons`, `update_lessons`: LESSONS.md の読み書き
5. **ltm**: 長期記憶（fenghuang ベース）
   - 会話メッセージの取り込み（ingestion）はメインプロセスで自動化（ホームチャンネルのメッセージのみ、bot 自身の発言を含む）
   - `ltm_retrieve`: ハイブリッド検索（テキスト＋ベクトル＋FSRS リランキング）で関連記憶を取得
   - `ltm_consolidate`: エピソードからファクト（意味記憶）を抽出・統合
   - `ltm_get_facts`: 蓄積されたファクト一覧を取得
6. **MC ブリッジ**（core-server 内、Discord 側）: Minecraft エージェントとの通信
   - `minecraft_delegate`, `minecraft_status`, `minecraft_read_reports`, `minecraft_start_session`, `minecraft_stop_session`
7. **minecraft**（`MC_HOST` 設定時のみ有効）: Minecraft 操作（mineflayer ベース）
   - `observe_state`: 現在状態の要約を取得（実装済み）
   - `get_recent_events`: 直近重要イベント取得（実装済み）
   - `follow_player`: 指定プレイヤーへ追従（実装済み）
   - `go_to`: 指定地点へ移動（実装済み）
   - `collect_block`: 指定ブロックを採集（実装済み）
   - `stop`: 現在の移動・追従を停止（実装済み）
   - `get_job_status`: ジョブ状態・履歴取得（実装済み）
   - `get_viewer_url`: Minecraft ビューアーの URL を返す（実装済み）
   - `craft_item`: 指定アイテムをクラフト（実装済み）
   - `place_block`: 指定ブロックを設置（実装済み）
   - `equip_item`: アイテム装備（実装済み）
   - `sleep_in_bed`: 就寝を試行（実装済み）
   - `send_chat`: Minecraft 内チャット送信（実装済み）
   - `eat_food`: 食料を食べる（実装済み）
   - `flee_from_entity`: 指定エンティティから逃走（実装済み）
   - `find_shelter`: 安全な避難場所を探す（実装済み）
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
- **LTM ファクト注入**: `loadBootstrapContext()` 時に LTM（fenghuang）から蓄積済みファクト（SemanticFact）を読み取り、`<ltm-facts>` セクションとしてシステムプロンプトに注入する。これにより AI は過去の会話から抽出された意味記憶（ユーザー情報、関係性、嗜好等）を常時参照できる。

### 3.5 Guild 跨ぎコンテキスト分離

- 人格共通: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md` は全 Guild で共有。
- 記憶分離: `MEMORY.md`, `LESSONS.md`, 日次ログ (`memory/`) は Guild ごとに `guilds/{guildId}/` で分離（オーバーレイ方式で `data/context/` → `context/` のフォールバック）。
- LTM（fenghuang）も Guild ごとに `data/fenghuang/guilds/{guildId}/memory.db` で分離。
- DM やフォールバック時はグローバルを使用。
- MCP memory ツールでは `guild_id` パラメータで Guild 固有メモリにアクセス。
- Guild 間で会話内容・メンバー情報・教訓が漏洩しない。

### 3.6 記憶システムマイグレーション方針

ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）と LTM（Episodes, SemanticFacts）の責任範囲を段階的に整理する。完全廃止はしない。

#### 記憶の責任分離

| 情報の種類                         | 担当システム     | 理由                        |
| ---------------------------------- | ---------------- | --------------------------- |
| ユーザー情報（名前、特徴、関係性） | LTM SemanticFact | 会話から自動抽出可能        |
| メンバーの性格・好み               | LTM SemanticFact | 会話から自動抽出可能        |
| チャンネル設定メモ                 | MEMORY.md        | 運用固有、自動抽出不適      |
| 行動ルール                         | MEMORY.md        | AI の自己指示、構造化が必要 |
| 週次目標・運用メモ                 | MEMORY.md        | 時限的、手動管理が適切      |
| 精選教訓                           | LESSONS.md       | AI がキュレーション、高品質 |
| 会話内容の要約                     | LTM Episodes     | 会話から自動生成            |
| Heartbeat 実行記録・自省メモ       | 日次ログ         | 時系列記録（運用メモのみ）  |

#### マイグレーションフェーズ

1. **Phase 1**: LTM ファクトをシステムプロンプトに注入（`LtmFactReader` ポート + `<ltm-facts>` セクション）
2. **Phase 2**: MEMORY.md のスリム化（ユーザー情報を LTM に委譲、運用特化に限定）
3. **Phase 3**: 日次ログ再設計 + LESSONS.md 整理（記録内容の限定、LTM guideline との連携）

各フェーズ間に数日の観察期間を設け、情報ロスがないことを確認してから次に進む。

### 3.7 エラー応答

- AI 呼び出し失敗時は、エラーメッセージを reply で返す。
- 失敗内容はログに記録する。

### 3.8 Minecraft 連携方針（初期実装）

- 既存の OpenCode + MCP + memory 構成は置き換えない。
- Minecraft 連携は新規 `minecraft` MCP サーバー追加で実現する。
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

#### 3.11.1 現行責務

- 現在の実装は単一の Minecraft `AgentRunner` に判断が集中している。
- `observe_state` / `get_recent_events` / `get_job_status` を用いて状況を要約し、低レベル MCP ツール呼び出しへ落とし込む。
- Discord からの依頼受付、Minecraft 側の自律行動、進捗記録、報告判断は同一エージェント内で処理する。

#### 3.11.2 M13a で整理した将来方針

- Minecraft エージェントは「常時 1 つの人格」を維持しつつ、内部ではオーケストレータと責務別 subagent 群へ分割可能な構造を目指す。
- subagent は常時並列稼働させず、必要時のみ短命に起動する役割プロセスとして扱う。
- 想定ロールは次の 5 つ:
  - `Observer`: 状況要約、危険抽出、イベント整理
  - `Planner`: 直近目標から数手先の計画作成
  - `Executor`: 単発の具体アクション決定
  - `Critic`: 実行結果評価、停止・継続・再計画判定
  - `Social`: Discord 依頼の解釈、報告粒度調整、優先順位反映
- 低レベル Minecraft ツールは全ロールへ無制限に開放しない。特に `Executor` 以外は原則として要約データと計画データ中心に扱う。
- Discord 雑談人格は引き続き本体側で維持し、Minecraft 側の subagent 化は外向き人格の分裂を目的としない。
- M13a 時点では scratchpad、専用 DB、追加プロセス常駐化は未導入とし、まず責務境界の文書化を優先する。

#### 3.11.3 現時点の主要ギャップ

- 観察・計画・実行・内省が単一プロンプトに混在している。
- 危険時の即応と平常時の長めの判断が同じ 30 秒ポーリングへ依存している。
- ワールド進捗、拠点状態、技術段階、依頼履歴の構造化が不足している。
- 失敗行動の抑止、再計画条件、Discord 依頼と自律目標の優先順位が未定義である。

#### 3.11.4 M13c で定義する実行安全性ルール

- 危険イベント（`death`, `kicked`, `disconnect`, `damage`, 高重要度 hostile 接近）は、平常時の目標駆動判断より優先する。
- 危険時は進行中ジョブを継続せず、まず `stop` を試み、その後 `eat_food` / `flee_from_entity` / `find_shelter` / `sleep_in_bed` の順で生存行動へ切り替える。
- 平常時の判断ループと、危険時の短い即応判断ループを分けて扱う。危険時ループでは長い計画立案や採集・探索を開始しない。
- `get_job_status` で失敗またはキャンセルが連続した同系統ジョブは、その場で即再試行せずクールダウン対象とする。
- 再試行は「前提条件が変わった」と説明できる場合に限定する。例: 体力回復、食料補充、夜明け、対象再発見。
- Discord からの通常依頼は危険回避より下位とし、緊急回避中は延期または中断報告を返してよい。
- Discord 通知は、死亡、キック、切断、依頼失敗、危険回避開始、危険回避完了、長時間スタック時に限定する。
- M13c 時点では、危険時の即応を「既存ツールを使う標準手順」として定義し、新たな自動戦闘ロジックや常駐監視プロセスは追加しない。

## 4. 非機能要件

- 初期の実行環境はローカル常駐（Bun ランタイム）とする。
- 明示的な性能 SLA は当面設けない。
- 秘密情報（トークンなど）はログに平文出力しない。

## 5. 設定要件

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- `OPENCODE_MODEL_ID`: AI モデル ID（デフォルト: `big-pickle`）
- `MC_PROVIDER_ID`: Minecraft エージェント用プロバイダ ID（省略時は `OPENCODE_PROVIDER_ID` にフォールバック）
- `MC_MODEL_ID`: Minecraft エージェント用モデル ID（省略時は `OPENCODE_MODEL_ID` にフォールバック）

## 6. 受け入れ条件

### 現行（実装済み）

1. Bot メンションで AI 応答が返る。
2. Bot 自身のメッセージには反応しない。
3. セッション管理が永続化され、再起動後も継続できる。
4. ブートストラップコンテキストが毎回 system prompt として注入される。
5. MCP サーバー経由で Discord 操作・コード実行が可能。
6. AI がイベントバッファをポーリングし、自律的に応答を判断・送信する。

### Minecraft 拡張（M6 完了時）

7. `minecraft` MCP サーバー経由で、接続・状態取得・追従/移動・基本採集の最小フローが動作する。
8. AI が Minecraft 状況を簡潔に要約して Discord 上で説明できる。
