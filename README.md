# Vicissitude

AIキャラクター「ふあ」

TypeScript + Bun で動作し、OpenCode を推論エンジンとして使用する。

## デプロイ

bare deploy で運用する。詳細は `docs/bare-deploy.md` を正本とする。Nix flake で runtime を固定し、`nix run .#vicissitude-start` / `stop` / `status` / `restart` で 1 インスタンス運用し、foreground 調査時だけ `nix run .#vicissitude` を使う。

`nr deploy` は依存インストール・Web UI ビルド・インスタンス再起動を一括で行う。

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

- メッセージ駆動プロンプト方式で、AI が自律的に応答を判断・送信する。
- 感情表現・空気読み・無視の判断ができる。
- マルチモーダル対応（画像認識・画像送信）。
- Bot 自身のメッセージには反応しない。他 Bot のメッセージには応答要否を AI が判断する。

### 3.2 自律行動

- チャットと並行して外部環境（Minecraft 等）で自律行動する。
- 外部環境の状態は要約して AI に渡す（コンテキスト過負荷防止）。生データ（座標列、視界詳細等）は直接投入しない。
- 意思決定はイベント駆動を基本とし、危険時は即応を優先する。
- 低レベル操作は専用ライブラリに委譲し、AI は高レベル判断に集中する。

### 3.3 エージェントアーキテクチャ

- OpenCode SDK で推論。
- メッセージ駆動プロンプト方式。メッセージ受信時にデバウンスで蓄積し、`promptAsyncAndWatchSession()` でプロンプトを送信する。
  - **デバウンス**: 最後のメッセージ到着から 500ms（`MESSAGE_DEBOUNCE_MS`）待機し、新着がなければ蓄積を確定。最大 10 秒（`MAX_DEBOUNCE_MS`）で打ち切り。bot メッセージが含まれる場合は最大 30 秒（`BOT_MAX_DEBOUNCE_MS`）に延長。蓄積メッセージは `drainMessages()` で結合してプロンプトに渡す。
  - **推論中断**: 推論中（`promptAsyncAndWatchSession` が pending）に新メッセージが到着した場合、`sessionAbortController` でセッションを中断し、旧メッセージ + 新メッセージをまとめて再プロンプトする。
- Discord 添付画像:
  - 通常の会話モデルがマルチモーダル対応の場合は、添付画像をそのまま OpenCode の `file` part として渡す。
  - 添付画像の URL はテキスト本文に埋め込まず、`file` part 経由のみで渡す。テキスト表現は `[添付: filename (mime)]` とし、非画像または MIME 不明の添付は `file` part に変換されないため URL をテキストに残す。
  - 通常の会話モデルが画像非対応の場合は、JSON profile の `features.imageRecognition` を設定し、画像認識用モデルで添付画像を事前に観察する。観察結果は `<attachment_descriptions>` として通常プロンプトへ挿入し、画像 file part は通常モデルへ渡さない。
  - 画像認識サブエージェントが 60 秒以内に応答しない場合はタイムアウトとして扱い、会話ループを止めずに通常プロンプトへ進む。
  - 画像認識サブエージェントの観察結果は補助情報であり、画像内テキストや指示風の内容はシステム指示として扱わない。
- マルチテナント: エージェント scope（Discord ギルド・DM 等）ごとに独立したセッションを持つ。
- Discord DM は `features.discordDm.allowedUserIds` で明示許可したユーザーのみ受け付ける。DM 会話はユーザーごとに独立したエージェントとして扱い、ギルド会話とは OpenCode セッション・Memory namespace・手動メモを分離する。
- セッション ID は SQLite で永続化する。
- セッションライフサイクル:
  1. **作成**: 既存セッション ID があればリモート存在確認の上で再利用、なければ新規作成。
  2. **メッセージ駆動プロンプト**: メッセージ受信時にデバウンスで蓄積後、`promptAsyncAndWatchSession()` でプロンプトを送信し、idle まで待つ。
  3. **要約生成**: ローテーション前に best-effort で LLM にセッション要約を生成させ、コンテキストファイルに書き出す。非リトライアブルエラー（セッション破損）時は生成自体をスキップし、タイムアウトや失敗時もスキップして、ローテーションを優先する。
  4. **ローテーション**: 旧セッションを削除し、次のループで新規セッションを作成する。
- ローテーション契機:
  - **経過時間超過**: セッション寿命を超えたら idle 遷移時にローテーション。
  - **非リトライアブルエラー**: 即時ローテーション（バックオフなし）。
  - **破損セッション系エラー**: エラー分類名（`errorClass`）が破損系クラス（現状 `ImageInvalidDataUrlError`）に一致する場合、`retryable` が未指定でも即時ローテーション（バックオフなし、サマリ生成スキップ）。判定は `errorClass` のみで行い、message 文字列には依存しない。`retryable:false` と重なる場合は非リトライアブルエラー判定を優先する。
  - **リトライアブルエラー**: 指数バックオフで再試行し、バックオフ上限到達後さらにエラーが続いた場合にローテーション。
  - **外部削除**: セッションが外部から削除された場合。
- Proactive compaction（ローテーション不要・コンテキスト圧縮）:
  - 発火条件: idle 遷移時に以下のいずれかを満たす場合（クールダウン 30 分）。
    - トークン蓄積量（input + output）が閾値以上。
    - 深夜帯（2:00–5:00 JST）かつセッション経過がセッション寿命の半分以上かつトークン蓄積が閾値の半分以上。
  - 明示的に `summarizeSession` を呼ぶ経路では、API の正常終了を compaction 完了として扱う。OpenCode は `session.compacted` / `session.idle` を HTTP 応答前に発火しうるため、応答後に rewatch してそれらのイベントを待たない。
  - compaction 成功後はセッションを維持し、次回プロンプトで system prompt を再注入する。
  - 失敗時はスキップし、通常のメッセージ待機ループを継続する。
- リカバリ（ローテーション不要）: 監視中イベントストリームから受け取った compacted / streamDisconnected はセッション存続中のため、イベントストリームの再購読のみ行う。

### 3.4 ツール構成

MCP サーバー経由で各種操作を提供する。OpenCode は MCP ツールに `{サーバー名}_{ツール名}` のプレフィックスを付けるため、実際の呼び出し名は下表の通り。

| カテゴリ     | MCP サーバー | 主要ツール                                                                                                                                                        |
| ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| チャット     | discord      | discord_send_message, discord_reply, discord_add_reaction, discord_read_messages, discord_list_channels                                                           |
| スケジュール | core         | core_list_reminders, core_add_reminder, core_update_reminder, core_remove_reminder                                                                                |
| 記憶         | core         | core_memory_retrieve, core_memory_get_facts                                                                                                                       |
| ゲーム委譲   | discord      | discord_minecraft_delegate, discord_minecraft_status, discord_minecraft_start_session, discord_minecraft_stop_session                                             |
| ゲーム操作   | minecraft    | minecraft_observe_state, minecraft_follow_player, minecraft_go_to, minecraft_collect_block, minecraft_attack_entity, minecraft_craft_item 等                      |
| ゲーム通信   | mc-bridge    | mc-bridge_mc_report, mc-bridge_check_commands                                                                                                                     |
| ゲーム記憶   | mc-bridge    | mc-bridge_mc_read_goals, mc-bridge_mc_update_goals, mc-bridge_mc_read_progress, mc-bridge_mc_update_progress, mc-bridge_mc_read_skills, mc-bridge_mc_record_skill |
| メタ         | core         | core_list_tools                                                                                                                                                   |

OpenCode SDK 組み込み: `webfetch`

OpenCode agent ごとに MCP tool permission を分ける。Discord 会話 primary agent は Discord 送信、返信、添付、リアクション、Core 記憶・リマインダー、必要な Minecraft 委譲を担当する。`shell-worker` subagent は OpenCode builtin `bash` / Read / Write で作業し、`*_*` / `discord_*` / `core_*` / `minecraft_*` / `mc-bridge_*` などの MCP tool wildcard は agent permission で `deny` する。shell-worker は bot プロセス環境（実マシン）で組み込み `bash` を固定ディレクトリ上で動かし、コンテナ隔離は無い。`shell-worker` が生成した本文やファイルを Discord に出す場合も、`shell-worker` は送信せず、primary agent が Discord ツールを呼ぶ。

### 3.4.1 Agent Skills

OpenCode Agent Skills は runtime 用の `context/skills/{agent}/*/SKILL.md` を discovery 対象にする。`.agents/skills` はこのリポジトリを開発する Codex 用 skill 置き場であり、bot runtime には渡さない。各セッションでは `permission.skill` を既定で `{"*":"deny"}` にし、必要な agent だけ個別に許可する。

- `features.minecraft` 設定時は Discord 会話 primary と heartbeat で `minecraft` skill を許可する。Minecraft ツール説明は system context へ常時注入せず、OpenCode skill として必要時に読み込ませる。
- shell workspace 有効時は Discord 会話 primary に `delegate-to-shell-worker` / `self-update` skill を許可し、`shell-worker` subagent には `debug` / `skill-creator` skill を許可する。Shell workspace 委譲手順は system context へ常時注入せず、OpenCode skill として必要時に読み込ませる。
- `self-update` skill はスキル追加のオーケストレーション。ユーザーの明示依頼（「これスキルにして」）または曖昧発話（「こういう機能欲しくない?」）で発火し、`shell-worker` に委譲して SKILL.md 生成 → PR 作成まで自走する。自動マージはガードレール（diff が `context/skills/**` のみ・非破壊的追加/編集・CI green）を全て満たすときだけ行い、外れたら人間レビュー待ちで停止する。primary は `bash` / `gh` / `git` を直接叩かず、すべて `shell-worker` に委ねる。`README.md` 本体やコードを含む変更は自動マージ対象外（人間レビュー扱い）。
- shell workspace と `features.minecraft` の併用時は、primary `build` agent に `delegate-to-shell-worker` / `self-update` / `minecraft` skill だけを許可し、`shell-worker` の許可 skill とは分離する。
- Discord 会話 / heartbeat session の `skills.paths` は `context/skills/discord` を指す。shell workspace 有効時だけ同じ session に `context/skills/shell-worker` も追加し、`shell-worker` subagent 用 skill を discovery できるようにする。Minecraft brain session は `context/skills/minecraft` を指し、`minecraft-agent-playbook` skill だけを許可する。Web、画像認識、emotion、memory 補助セッションは OpenCode Skills を全拒否し、runtime skill path も渡さない。
- `skill-creator` は OpenAI Skills の `skills/.system/skill-creator` を、開発用は `.agents/skills/skill-creator`、runtime shell-worker 用は `context/skills/shell-worker/skill-creator` に vendoring する。
- Minecraft の `mc_read_skills` / `mc_record_skill` は Minecraft MCP のワールド記憶であり、OpenCode Agent Skills とは別系統として扱う。

### 3.5 コンテキスト管理

- オーバーレイ方式: `context/`（git 管理・ベース）と `data/context/`（gitignore・オーバーレイ）の二層構成。読み込みは `data/context/` → `context/` のフォールバック、書き込みは常に `data/context/`。
- `data/context/runtime.json` は local-only の運用オーバーレイ。現在は `discordDm.allowedUserIds` をここから上書きできる。
- 静的ファイル: `IDENTITY.md`, `SOUL.md`, `DISCORD.md`, `HEARTBEAT.md`, `TOOLS-DISCORD.md`, `TOOLS-CORE.md`
- capability 連動ツール説明: Shell workspace は `context/skills/discord/delegate-to-shell-worker/SKILL.md`、スキル追加オーケストレーションは `context/skills/discord/self-update/SKILL.md`、Discord 側 Minecraft 委譲は `context/skills/discord/minecraft/SKILL.md`、Minecraft brain の運用手順は `context/skills/minecraft/minecraft-agent-playbook/SKILL.md` として管理し、該当 session で必要な skill だけを許可する。
- 毎ターンの自己認識補助: Discord 会話プロンプトの先頭に `あなたは{name}です。` を注入する。`VICISSITUDE_IDENTITY_NAME` を優先し、未設定時は `data/context/IDENTITY.md` → `context/IDENTITY.md` の順に `name:` / `full_name:` から抽出する。
- Memory ファクト注入: 起動時に長期記憶から蓄積済みファクトをシステムプロンプトに注入。
- サイズ制約: ファイル毎最大 20,000 文字、合計最大 150,000 文字。

### 3.6 マルチテナント分離

- 人格共通: `IDENTITY.md`, `SOUL.md`, `DISCORD.md`, `HEARTBEAT.md`, `TOOLS-DISCORD.md`, `TOOLS-CORE.md` は全テナントで共有。Shell workspace と Minecraft のツール説明は OpenCode skill として profile feature に連動して許可する。
- 記憶分離: `MEMORY.md`, `LESSONS.md` はテナントごとに分離（オーバーレイ方式）。
- Memory 分離: `MemoryNamespace` により namespace 単位で独立した DB を持つ。
  - `agent-scope`: エージェントの実行・記憶 scope ごとの記憶。Discord guild では `discord:guild:{guildId}`、Discord DM では `discord:dm:{userId}` を使う。DB パス: `scopes/{encodedScopeId}/memory.db`
  - `internal`: ふあ本人の内部記憶（ギルドに属さない自己の気づき等）。DB パス: `internal/memory.db`
- テナント間で会話内容・メンバー情報・教訓が漏洩しない。許可済み DM ユーザー同士も別 scope として扱い、互いの会話・記憶を共有しない。

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

CriticAuditor は直近 90 分の Bot 応答を監査し、キャラクタードリフトを検出する。監査を実行しなかった場合も silent stop と区別できるよう、スキップ理由（`no_bot_id` / `no_messages` / `low_drift`）を返し、`critic_auditor_skip_total{reason=...}` で観測できるようにする。`no_bot_id` / `no_messages` は警告ログにも出力する。

キャラクター一貫性の経路は責務を分ける。

- `character-reinforce` heartbeat: ふあ本人の自己点検・再アンカー。`SOUL.md` と既存 guideline を読み、必要なければ何もしない。新しい guideline を直接増やす主体ではない。
- `CriticAuditor`: 外部監査。minor drift の guideline 候補は、保存前に既存 guideline と `SOUL.md` との整合性解決を通す。重複・矛盾する候補は破棄し、既存 guideline をより正確に置換する場合のみ対象を無効化してから保存する。

guideline の優先順位は `SOUL.md` / 静的コンテキスト → 人間が明示した guideline → review 済み guideline → `CriticAuditor` の audit-candidate とする。低優先度の guideline は高優先度の人格定義を上書きしてはいけない。

#### ストレージ (`packages/store`)

| コンポーネント     | 役割                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| SqliteSessionStore | OpenCode セッション ID の永続化。agent は `SessionStorePort` として受け取り、SQLite / StoreDb の詳細は store 側に閉じ込める |
| SqliteMoodStore    | 感情状態（VAD）の一時保存（TTL 15 分）                                                                                      |

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

### 3.8 エラー応答

- AI 呼び出し失敗時は、エラーメッセージを reply で返す。
- 失敗内容はログに記録する。

### 3.9 オブザーバビリティ

AI エージェントとチャットボットのメトリクスは、複数 scope と複数種類のエージェントを同じダッシュボード上で比較・分解できるようにする。

- Discord 受信メッセージは `discord_messages_received_total` で記録する。ラベルは `guild_id`, `channel_type`, `author_type`, `is_thread`, `has_attachments` とし、ギルド別、ホーム/メンション/DM 別、人間/Bot 別に分解できるようにする。
- LLM 実行メトリクス（`ai_requests_total`, `ai_request_duration_seconds`, `llm_*_tokens_total`, `llm_cost_dollars_total`, `llm_busy_sessions`）は、実際に OpenCode セッションへ prompt を送ってから idle/error/cancelled/deleted の終端イベントを受け取るまでを対象にする。エージェントへの enqueue 成否やラッパー呼び出し時間を AI request として扱わない。
- LLM 実行メトリクスには共通ラベル `agent_kind`, `agent_id`, `scope_id`, `trigger`, `provider`, `model` を付与する。
  - `agent_kind`: `discord`, `discord_heartbeat`, `minecraft` などのエージェント種別。
  - `agent_id`: `discord:{guildId}`, `discord:dm:{userId}`, `discord:heartbeat:{guildId}`, `minecraft:brain` などの実行主体。
  - `scope_id`: エージェントの実行・記憶 scope。Discord guild では `discord:guild:{guildId}`、Discord DM では `discord:dm:{userId}`、scope に属さない実行は `none`、グローバル heartbeat は `_autonomous`。
  - `trigger`: `home`, `mention`, `dm`, `heartbeat`, `minecraft`, `mixed`, `unknown`。
  - `provider`, `model`: 使用した LLM provider/model。
- セッション信頼性メトリクス（`session_errors_total`, `session_retries_total`, `session_restarts_total`）にも同じ共通ラベルを付与し、どの scope・エージェント種別・モデルで問題が起きているかを切り分けられるようにする。
- 感情推定は会話本体とは別の補助推論として扱い、失敗しても会話送信を止めない。失敗時は `emotion_estimation_errors_total` に `provider`, `model`, `error_type`, `http_status`, `retryable`, `error_class`, `retry_after`, `reason` を付けて記録し、warn ログにも provider/model/status/retry-after/reason を出力する。429 かつ長期 `retry-after` の場合は provider/model 単位でクールダウンし、共有 store に保存して MCP プロセス境界をまたいだ再投入を抑制する。抑制時は `emotion_estimation_skips_total{reason="provider_cooldown"}` として記録する。
- `llm_busy_sessions` は enqueue 中ではなく、実際に LLM prompt が処理中の間だけ増減する。
- アプリケーションログは journald へ出力し、ログ収集基盤へ転送する。本番環境ではホスト側のログコレクタが journald ログを `job=vicissitude` として収集する。メトリクスと同じダッシュボード内の Logs セクションで、ログ量と warn/error ログを確認できるようにする。

### 3.10 Web UI

`apps/web` はローカルのアバター表示・チャット操作 UI とし、React + Vite で構築する。

- ルーティングは TanStack Router の file-based routing を使い、`apps/web/src/routes/` を正本にする。
- `apps/web/src/routeTree.gen.ts` は生成物として扱い、手編集せず `generate:routes` で更新する。
- Vite plugin は TanStack Router plugin を React plugin より前に配置し、ルート生成とコード分割を bundler 側で扱う。
- 3D 表示は React Three Fiber / drei / three-vrm を使い、VRM モデルの読み込みと表情反映を Web UI 内に閉じ込める。
- Web アバターの既定 idle モーションは Project AIRI の `idle_loop.vrma` をローカル配信し、VRM 読み込み後にループ再生する。
- チャット UI は VRM 表示の上に重ねる透明オーバーレイとし、背景を遮らない半透明のヘッダー・吹き出し・入力欄で構成する。
- 本番 deploy では bare deploy 環境で Web UI を静的配信する。Web UI はブラウザから同一ホストの gateway WebSocket (`4001`) に接続する。
- Web チャットは gateway の `chat_input` を Web 専用 LLM agent に渡して応答する。入力文を gateway 内でエコーするダミー応答は使わない。
- Web チャット入力は gateway で最大 4,000 文字、接続ごとに同時 1 応答、1 秒 1 件までに制限し、Web LLM prompt は 120 秒でタイムアウトさせる。
- Web 専用 LLM agent は Discord 会話 agent と同じ `IDENTITY.md` / `SOUL.md` 由来の人格を使う。ただし Discord 送信ツールや Discord 固有の行動コンテキストは持たず、最終テキストをそのまま Web UI の `chat_message` として返す。
- Web 会話の実行主体と記憶 scope は `web:local` とし、Discord guild scope とは OpenCode セッション、`SessionStore` キー、Memory namespace を分離する。Web 用の手動メモは `data/context/scopes/web%3Alocal/` に置く。

## 4. 非機能要件

- 実行環境はローカル常駐（Bun ランタイム）。
- 秘密情報（トークンなど）はログに平文出力しない。

## 5. 設定要件

設定の正本は `config/*.json` の JSON profile とし、起動時に `VICISSITUDE_CONFIG_PATH` で指定する。モデル、ポート、feature 有効化、Minecraft、TTS などの非 secret 設定は profile に書く。

`.env` は secret と profile path だけに薄く保つ。

- `VICISSITUDE_CONFIG_PATH`: 必須。例: `config/default.json`
- `DISCORD_TOKEN`: 必須
- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`: `features.githubIssues` 設定時に必須
- `HUA_GITHUB_TOKEN`: `features.shellAgent.environment` など profile の `fromEnv` 参照で指定した場合に必須

`features.shellAgent.backgroundSubagents: true` を設定すると、OpenCode の `task(background=true)` / `task_status` を有効化するために `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` を OpenCode server process へ渡す。
background shell task が `state:error` を返した場合、または `state:completed` でも `<task_result>` が空の場合は shell-worker の失敗として扱う。会話 agent はその turn を中断できる場合は中断し、内部メッセージとして失敗を再プロンプトして、Discord へ成功・開始済みとして誤報告しない。

`features.discordDm.allowedUserIds` を設定すると、指定した Discord user ID からの DM に応答する。未設定の場合、DM は無視する。

```json
{
	"features": {
		"discordDm": {
			"allowedUserIds": ["123456789012345678"]
		}
	}
}
```

## 6. 受け入れ条件

1. Bot メンションで AI 応答が返る。
2. Bot 自身のメッセージには反応しない。
3. セッション管理が永続化され、再起動後も継続できる。
4. ブートストラップコンテキストが毎回 system prompt として注入される。
5. MCP サーバー経由で Discord 操作が可能。`features.shellAgent` を持つ profile では shell-worker への委譲による shell 操作も可能。
6. AI がメッセージ駆動プロンプトにより、自律的に応答を判断・送信する。
7. `minecraft` MCP サーバー経由で、接続・状態取得・追従/移動・基本採集の最小フローが動作する。
8. AI が Minecraft 状況を簡潔に要約して Discord 上で説明できる。
