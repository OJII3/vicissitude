# STATUS.md

## 1. 最終更新

- 2026-03-09
- 更新者: claude-code
- ブランチ: feat/minecraft-tools-5

## 2. 現在の真実（Project Truth）

- Clean Architecture への移行が完了し、main にマージ済み。
- domain / application / infrastructure の 3 層構成で、依存方向ルールは正しく守られている。
- DI は手動コンストラクタ注入（Pure DI）で `composition-root.ts` に集約している。
- テストは `bun test` で実行可能。
- **Default モードを廃止し、ポーリングモードに一本化。** judge/cooldown/batching 等の従来フローを削除し、コードベースを大幅に簡素化。
- AI 推論は OpenCode SDK 経由。プロバイダとモデルは環境変数で設定可能。本筋エージェント: `OPENCODE_PROVIDER_ID`（デフォルト: `github-copilot`）/ `OPENCODE_MODEL_ID`（デフォルト: `big-pickle`）。LTM: `LTM_PROVIDER_ID`（フォールバック: `OPENCODE_PROVIDER_ID` → `github-copilot`）/ `LTM_MODEL_ID`（デフォルト: `gpt-4o`）。
- **ポーリングモード**: `PollingAgent` が 1 回の `promptAsync()` で AI にバッファをポーリングさせる。全イベントを `FileEventBuffer` に JSONL で書き込み、AI が `event-buffer` MCP ツールで消費。1 セッションで全イベントを処理するためプロンプト課金を節約。
- セッションは `data/sessions.json` に JSON で永続化している。**セッション自動ローテーション: 48 時間（`SESSION_MAX_AGE_HOURS` で変更可）経過後にセッションを削除・再作成し、トークン蓄積を防止。**
- ブートストラップコンテキストはオーバーレイ方式で読込む: `data/context/` → `context/` のフォールバック。書き込みは常に `data/context/` に行う。
- チャンネル設定は `data/context/channels.json` → `context/channels.json` のフォールバックで管理する。
- MCP サーバーは `discord-server.ts`（Discord 操作）、`code-exec-server.ts`（コード実行）、`schedule-server.ts`（Heartbeat スケジュール管理）、`memory-server.ts`（メモリ・人格管理）、`event-buffer-server.ts`（イベントバッファ）、`ltm-server.ts`（長期記憶）、`minecraft-server.ts`（Minecraft 操作、`MC_HOST` 設定時のみ）の 7 つ。
- **Heartbeat 自律行動システム: 1分間隔チェックループで due なリマインダーを検知し、AI セッションを起動して自律行動する。**
- **memory MCP サーバーで MEMORY.md / SOUL.md（読み取り専用） / LESSONS.md / 日次ログの構造化された読み書きが可能。**
- **`evolve_soul` ツールを廃止し、LESSONS.md に一本化。** SOUL.md はペルソナ定義に専念させ、「学んだこと」セクションを削除。既存エントリは guild LESSONS.md にマイグレーション済み。
- **Guild 跨ぎコンテキスト分離: 人格は全 Guild 共通、記憶（MEMORY, LESSONS, 日次ログ）は Guild ごとに分離。**
- **OpenCode SDK 組み込みの `webfetch` / `websearch` ツールを有効化済み。**
- **`composition-root.ts` をリファクタリングし、`bootstrap-context.ts`（共有型）、`bootstrap-helpers.ts`（共有ヘルパー）、`bootstrap-agents.ts`（エージェントブートストラップ）に分割。**
- **`llm_busy_sessions` ゲージメトリクスを追加。** `InstrumentedAiAgent.send()` でインフライトリクエスト数を `agent_type` ラベル付きでトラッキング。
- **Ollama をコンテナ化。** `compose.yaml` で `ollama` サービスを追加し、`vicissitude-net` ネットワークで `bot` と通信。初回起動時に `embeddinggemma` モデルを自動プル。`OLLAMA_BASE_URL` のデフォルトを `http://ollama:11434` に変更。
- **記憶システムマイグレーション方針を策定。** ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）と LTM（fenghuang Episodes/SemanticFacts）の責任範囲を段階的に整理する計画を文書化（M5: 記憶システム統合）。
- **M5 Phase 1 完了: LTM ファクトのシステムプロンプト注入。** `LtmFactReader` ポート、`FenghuangFactReader` アダプタ（SQLite WAL モード読み取り専用）、`FileContextLoader` への `<ltm-facts>` セクション注入を実装。PR #63 でマージ済み。
- **M5 Phase 2 完了: MEMORY.md スリム化。** MEMORY.md の責任範囲を「運用設定・行動ルール・週次目標」に限定し、ユーザー背景情報は LTM ファクトに委譲。TOOLS.md / HEARTBEAT.md のガイドラインを更新し、MCP ツール説明文も改善。
- **M5 Phase 3 完了: 日次ログ再設計 + LESSONS.md 整理。** 日次ログの記録対象を「heartbeat 実行記録・自省メモ」に限定し、会話まとめは LTM Episodes に委譲。LESSONS.md と LTM guideline の使い分けを明確化し、更新前に LTM guideline を確認するフローを追加。
- **LTM 記録をホームチャンネルのみに限定。** `onAnyMessage`（全チャンネル購読）を廃止し、`onHomeChannelMessage` 経由でホームチャンネルのメッセージのみを記録するように変更。bot 自身の発言もホームチャンネル内であれば記録。
- **LTM 自動統合スケジューラ（ハイブリッド方式）。** 30 分間隔で未統合エピソードからファクトを自動抽出する `IntervalConsolidationScheduler` を追加。初回は 5 分遅延、タイムアウト 10 分。手動 MCP ツール `ltm_consolidate` もそのまま残す。`FenghuangConversationRecorder` に `MemoryConsolidator` ポートを実装。consolidation は `record()` のロックとは独立して実行（SQLite WAL モードで DB 側が直列化を保証）。タイムアウト後も内部処理完了まで `running` フラグを保持しゾンビ処理との並走を防止。`Executable` ドメインポートで CA 依存方向ルールを遵守。
- **LTM ファクト抽出に話者名を構造化フィールドで渡すように変更。** fenghuang の `ChatMessage.name` 対応に合わせ、`content` への著者名埋め込み（`"authorName: content"`）を廃止し、`ConversationMessage.name` フィールドで渡すように変更。fenghuang 側で `role(name)` 形式の話者表示とファクト抽出時の明示的な主語付与が有効になり、LTM ファクトの品質が向上。
- **ドキュメント方針を Minecraft 拡張前提に更新。** `PLAN.md` を全面更新し、`SPEC.md` / `ARCHITECTURE.md` に「既存人格維持 + Minecraft MCP 追加 + 要約/イベント駆動」の方針を反映。
- **Minecraft MCP サーバー（最小土台）。** mineflayer + mineflayer-pathfinder を使用し、`observe_state`（状態要約）と `get_recent_events`（イベントログ）の 2 ツールを提供。`MC_HOST` 環境変数設定時のみ有効化。オフラインモード接続、指数バックオフ自動再接続、インメモリリングバッファ（最大100件）でイベント蓄積。
- **Minecraft ゲームサーバーをコンテナ化。** `compose.yaml` に `itzg/minecraft-server:java21` ベースの `minecraft` サービスを追加。オフラインモード、メモリ 1GB 制限、`mc-health` ヘルスチェック、`minecraft-data` ボリュームでワールド永続化。`MC_HOST=minecraft` で bot から DNS 解決可能。
- **Minecraft MCP サーバーに行動ツールを追加。** `follow_player`（プレイヤー追従）、`go_to`（座標移動）、`collect_block`（ブロック採集）、`stop`（移動停止）の 4 ツールを `minecraft-actions.ts` に実装。mineflayer-pathfinder の GoalFollow/GoalNear/GoalGetToBlock を使用。
- **Minecraft 状態要約レイヤーとイベントログ整備。** `observe_state` が自然言語要約テキストを返すように変更（体力♥バー、hostile mob ⚠ 表示、インベントリ1行要約）。BotEvent に `importance` フィールド（low/medium/high）を追加し、health イベントをスロットリング（体力変化5以上 or 体力5以下のみ記録）。playerJoined/playerLeft/timeChange/weatherChange の新イベント種別を追加。`get_recent_events` に importance フィルタを追加しテキスト形式で出力。アクション状態（idle/following/moving/collecting）をトラッキング。要約関数は `minecraft-state-summary.ts`、ヘルパーは `minecraft-helpers.ts` に分離しテスト完備。
- **Minecraft アクションのジョブシステム化。** `go_to` / `collect_block` / `follow_player` を非同期ジョブ化し、即座に jobId を返すように変更。`JobManager` クラスがシングルジョブの排他制御・自動キャンセル・AbortSignal によるキャンセル伝播・進捗更新を管理。`stop` ツールは `jobManager.cancelCurrentJob()` 経由に統一。`get_job_status` ツールを追加しジョブ履歴の確認が可能。`minecraft-bot-queries.ts` にヘルパー関数を切り出しファイル分割を推進。
- **`take_screenshot` MCP ツールを実装。** `prismarine-viewer` + `node-canvas-webgl` + `three` によるヘッドレスレンダリングでボット一人称視点の PNG スクリーンショットを撮影。MCP `image` content type で AI が画像を直接認識可能。チャンクレンダリング 10 秒タイムアウト付き。Containerfile に Node.js / Cairo / Mesa / Xvfb を追加し `xvfb-run` で起動。
- **Discord MCP サーバーの `send_message` / `reply` に `file_path` パラメータを追加。** オプショナルなファイル添付送信に対応し、スクリーンショット画像の Discord 送信が可能。
- **Minecraft MCP ツール 5 種追加。** `send_chat`（ゲーム内チャット送信）、`equip_item`（アイテム装備）、`place_block`（ブロック設置、隣接ブロック自動検出）、`craft_item`（クラフト、作業台自動移動、ジョブシステム使用）、`sleep_in_bed`（就寝、全 16 色ベッド対応、ジョブシステム使用）を実装。
- `nr validate` (fmt:check + lint + check) および `bun test` が通る。
- Graceful shutdown（SIGINT/SIGTERM）実装済み。
- ペルソナ（SOUL.md）を全面刷新。Anti-AI-Slop ルール、会話参加判断基準、感情表現パターンを追加。
- **画像添付ファイルサポートを実装済み。** 対応 MIME タイプ: `image/png`, `image/jpeg`, `image/gif`, `image/webp`。

## 3. 確定済み方針

1. 人格名は「ふあ」。
2. TypeScript + Bun ランタイム。
3. Clean Architecture + Ports and Adapters。
4. Pure DI（DI コンテナなし）。
5. MCP サーバーは独立プロセスとしてレイヤー外に配置。
6. `STATUS.md` は作業ごとに更新する。
7. AI がイベントバッファをポーリングし、自律的に応答判断・送信する（ポーリングモード一本化）。
8. Heartbeat システムで定期的な自律行動を実行する（interval / daily スケジュール対応）。
9. スケジュール管理は MCP ツール経由で通常会話からも変更可能。
10. メモリ管理は専用 MCP サーバー経由で行い、安全策（バックアップ、サイズ上限、append-only）を適用。

## 4. 既知のバグ・要修正事項

- `PollingAgent` のコンストラクタ引数が 8 個に増加。`port` / `providerId` / `modelId` を設定オブジェクトにまとめることを将来的に検討。
- `GuildRoutingAgent.send()` がエラーを同期的にスローする（戻り値は `Promise<AgentResponse>`）。`.catch()` のみでハンドリングする呼び出し元が増えた場合は `Promise.reject()` に変更が必要。
- Ollama コンテナのイメージタグが `latest` 固定。再現性向上のためバージョン固定を将来的に検討。

## 5. 直近タスク

1. ~~`minecraft` MCP server の最小土台作成（接続 + `observe_state`）~~ **完了**
2. ~~Minecraft サーバーを compose.yaml にコンテナとして追加~~ **完了**
3. ~~`follow_player` / `go_to` / `collect_block` / `stop` の最小実装~~ **完了**
4. ~~Minecraft 状態要約レイヤーとイベントログ整備~~ **完了**
5. ~~Minecraft アクションのジョブシステム化~~ **完了**
6. ~~`take_screenshot` ツール実装（`prismarine-viewer` ヘッドレスレンダリング、Bun 互換性検証含む）~~ **完了**
7. ~~Discord MCP サーバーに画像添付送信機能を追加~~ **完了**
8. ~~`craft_item` / `place_block` / `equip_item` / `sleep_in_bed` / `send_chat` の実装~~ **完了**

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. ~~code-exec のサンドボックス欠如による RCE リスク~~ **対策済み** — Podman コンテナ化（ネットワーク遮断、読み取り専用 rootfs、全ケーパビリティ削除、メモリ/CPU/PID 制限）。
2. `bootstrap-agents.ts` は `infrastructure/opencode/` に配置しているが、実態はブートストラップ（DI 配線）ロジック。`src/` 直下や `src/bootstrap/` への移動を将来的に検討。現状は `import/no-cycle` 違反がなく動作に問題ないため許容。

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
