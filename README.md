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

### 3.1 会話

- イベント駆動ポーリング方式で、AI が自律的に応答を判断・送信する。
- 感情表現・空気読み・無視の判断ができる。
- マルチモーダル対応（画像認識・画像送信）。
- Bot 自身のメッセージには反応しない。他 Bot のメッセージには応答要否を AI が判断する。

### 3.2 自律行動

- チャットと並行して外部環境（Minecraft 等）で自律行動する。
- 外部環境の状態は要約して AI に渡す（コンテキスト過負荷防止）。生データ（座標列、視界詳細等）は直接投入しない。
- 意思決定はイベント駆動を基本とし、危険時は即応を優先する。
- 低レベル操作は専用ライブラリに委譲し、AI は高レベル判断に集中する。

### 3.3 エージェントアーキテクチャ

- OpenCode SDK + GitHub Copilot プロバイダ（claude モデル）で推論。
- `promptAsync()` による長寿命ポーリングプロンプト方式。エージェント自身が `wait_for_event` でイベントを待ち受ける。
- マルチテナント: テナント（Discord ギルド等）ごとに独立したセッションを持つ。
- セッション ID は SQLite で永続化する。
- セッションライフサイクル:
  1. **作成**: 既存セッション ID があればリモート存在確認の上で再利用、なければ新規作成。
  2. **長寿命ポーリング**: LLM が `wait_for_events` を繰り返し呼び、セッションを半永続的に維持する。
  3. **要約生成**: ローテーション前に best-effort で LLM にセッション要約を生成させ、コンテキストファイルに書き出す。タイムアウトや失敗時はスキップし、ローテーションを優先する。
  4. **ローテーション**: 旧セッションを削除し、次のループで新規セッションを作成する。
- ローテーション契機:
  - **経過時間超過**: セッション寿命を超えたら idle 遷移時にローテーション。
  - **非リトライアブルエラー**: 即時ローテーション（バックオフなし）。
  - **リトライアブルエラー**: 指数バックオフで再試行し、上限到達後も継続する場合にローテーション。
  - **ハング検知**: `wait_for_events` が一定時間呼ばれない場合、セッションがハングしたとみなしローテーション。MCP ハートビートも考慮する。
  - **外部削除**: セッションが外部から削除された場合。
- リカバリ（ローテーション不要）: compacted / streamDisconnected はセッション存続中のため、イベントストリームの再購読のみ行う。

### 3.4 ツール構成

MCP サーバー経由で各種操作を提供する。

| カテゴリ     | MCP サーバー | 主要ツール                                                                                            |
| ------------ | ------------ | ----------------------------------------------------------------------------------------------------- |
| チャット     | core         | send_message, reply, add_reaction, read_messages, list_channels                                       |
| イベント     | core         | wait_for_events                                                                                       |
| コード実行   | code-exec    | execute_code                                                                                          |
| スケジュール | core         | list_reminders, add_reminder, update_reminder, remove_reminder                                        |
| 記憶         | core         | memory_retrieve, memory_get_facts                                                                     |
| ゲーム委譲   | core         | minecraft_delegate, minecraft_status, minecraft_start_session, minecraft_stop_session                 |
| ゲーム操作   | minecraft    | observe_state, follow_player, go_to, collect_block, attack_entity, craft_item 等                      |
| ゲーム通信   | mc-bridge    | mc_report, check_commands                                                                             |
| ゲーム記憶   | mc-bridge    | mc_read_goals, mc_update_goals, mc_read_progress, mc_update_progress, mc_read_skills, mc_record_skill |
| 選曲         | core         | spotify_pick_track                                                                                    |
| 楽曲検索     | core         | spotify_search                                                                                        |
| お気に入り   | core         | spotify_saved_tracks                                                                                  |
| 楽曲詳細     | core         | spotify_track_detail                                                                                  |
| 歌詞取得     | core         | fetch_lyrics                                                                                          |
| 聴取記録     | core         | save_listening_fact                                                                                   |
| メタ         | core         | list_tools                                                                                            |

OpenCode SDK 組み込み: `webfetch`

### 3.5 コンテキスト管理

- オーバーレイ方式: `context/`（git 管理・ベース）と `data/context/`（gitignore・オーバーレイ）の二層構成。読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/`。
- 静的ファイル: `IDENTITY.md`, `SOUL.md`, `DISCORD.md`, `HEARTBEAT.md`, `TOOLS-CORE.md`, `TOOLS-CODE.md`, `TOOLS-MINECRAFT.md`
- Memory ファクト注入: 起動時に長期記憶から蓄積済みファクトをシステムプロンプトに注入。
- サイズ制約: ファイル毎最大 20,000 文字、合計最大 150,000 文字。

### 3.6 マルチテナント分離

- 人格共通: `IDENTITY.md`, `SOUL.md`, `DISCORD.md`, `HEARTBEAT.md`, `TOOLS-CORE.md`, `TOOLS-CODE.md`, `TOOLS-MINECRAFT.md` は全テナントで共有。
- 記憶分離: `MEMORY.md`, `LESSONS.md` はテナントごとに分離（オーバーレイ方式）。
- Memory 分離: `MemoryNamespace` により namespace 単位で独立した DB を持つ。
  - `discord-guild`: Discord ギルドごとの記憶。DB パス: `guilds/{guildId}/memory.db`
  - `internal`: ふあ本人の内部記憶（ギルドに属さない自己の気づき等）。DB パス: `internal/memory.db`
- テナント間で会話内容・メンバー情報・教訓が漏洩しない。

### 3.7 記憶システム

ファイルベースメモリと Memory パッケージを併用し、情報の種類に応じて担当を分離する。

#### Memory パッケージ (`packages/memory`)

会話から自動的に記憶を構築・検索するシステム。以下の 5 コンポーネントで構成される。

| コンポーネント        | 役割                                                                |
| --------------------- | ------------------------------------------------------------------- |
| Segmenter             | メッセージ列をエピソード単位に分割                                  |
| EpisodicMemory        | エピソード（会話の要約・メッセージ群）を保存。FSRS で復習管理       |
| ConsolidationPipeline | 未統合エピソードから SemanticFact を抽出（Predict-Calibrate-Learn） |
| SemanticMemory        | 意味記憶（ファクト）の保存・検索・無効化                            |
| Retrieval             | テキスト + ベクトル + FSRS のハイブリッド検索（RRF でマージ）       |

#### ストレージ (`packages/store`)

| コンポーネント    | 役割                                   |
| ----------------- | -------------------------------------- |
| SqliteEventBuffer | ポーリング用イベントバッファ           |
| SqliteMoodStore   | 感情状態（VAD）の一時保存（TTL 15 分） |

#### 情報の種類と担当

| 情報の種類                         | 担当                | 備考                         |
| ---------------------------------- | ------------------- | ---------------------------- |
| ユーザー情報（名前、特徴、関係性） | Memory SemanticFact | 会話から自動抽出             |
| メンバーの性格・好み               | Memory SemanticFact | 会話から自動抽出             |
| 会話内容の要約                     | Memory Episodes     | 会話から自動生成             |
| 個別の行動ガイドライン             | Memory guideline    | 会話から自動抽出。状況固有   |
| 会話中の自省・気づき               | Memory Episodes     | consolidation で抽出         |
| チャンネル設定メモ                 | MEMORY.md           | 運用固有、自動抽出不適       |
| 行動ルール                         | MEMORY.md           | AI の自己指示、構造化が必要  |
| 週次目標・運用メモ                 | MEMORY.md           | 時限的、手動管理が適切       |
| 運用ルール                         | MEMORY.md           | 開発者が設定する行動指示     |
| 精選教訓（原則）                   | LESSONS.md          | 複数経験から一般化。手動管理 |

### 3.8 音楽の理解・記憶

- 聴取対象は Spotify 連携で選曲された楽曲（`SpotifyTrack`）。
- 歌詞取得: Genius API を使用。歌詞が取得できない楽曲もあるため、歌詞 null でも動作する。
- 楽曲理解: Spotify メタ情報（ジャンル、人気度、リリース日）に加え、LLM が曲名・アーティスト・歌詞から以下を推測する。
  - ボーカル性別（`male` / `female` / `mixed` / `unknown`）
  - タイアップ情報（アニメ主題歌等、なければ null）
  - 曲の雰囲気・テーマ（複数の短いタグ）
  - 楽曲の短い要約
- 感想保存: 聴いた楽曲について LLM が感想を生成し、`SemanticFact`（category = `experience`）として Memory の internal namespace に保存する。曲名・アーティスト名を keywords に含め、既存の `memory_retrieve` / `memory_get_facts` で引き出せる。
- 保存先 namespace: `INTERNAL_NAMESPACE` + `HUA_SELF_SUBJECT`（ふあ自身の体験として記録、ギルド横断で参照可能）。

### 3.9 エラー応答

- AI 呼び出し失敗時は、エラーメッセージを reply で返す。
- 失敗内容はログに記録する。

## 4. 非機能要件

- 実行環境はローカル常駐（Bun ランタイム）。
- 秘密情報（トークンなど）はログに平文出力しない。

## 5. 設定要件

- `DISCORD_TOKEN`: 必須（`.env` から読込）
- `OPENCODE_MODEL_ID`: AI モデル ID（デフォルト: `big-pickle`）
- `MC_PROVIDER_ID`: Minecraft エージェント用プロバイダ ID（省略時は `OPENCODE_PROVIDER_ID` にフォールバック）
- `MC_MODEL_ID`: Minecraft エージェント用モデル ID（省略時は `OPENCODE_MODEL_ID` にフォールバック）
- `GENIUS_ACCESS_TOKEN`: Genius API アクセストークン（歌詞取得用、任意。未設定時は歌詞取得をスキップ）

## 6. 受け入れ条件

1. Bot メンションで AI 応答が返る。
2. Bot 自身のメッセージには反応しない。
3. セッション管理が永続化され、再起動後も継続できる。
4. ブートストラップコンテキストが毎回 system prompt として注入される。
5. MCP サーバー経由で Discord 操作・コード実行が可能。
6. AI がイベントバッファをポーリングし、自律的に応答を判断・送信する。
7. `minecraft` MCP サーバー経由で、接続・状態取得・追従/移動・基本採集の最小フローが動作する。
8. AI が Minecraft 状況を簡潔に要約して Discord 上で説明できる。
