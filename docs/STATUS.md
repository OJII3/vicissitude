# STATUS.md

## 1. 最終更新

- 2026-03-09
- 更新者: claude-code
- ブランチ: refactor/m7-foundation

## 2. 現在の真実（Project Truth）

- **モジュール構成への移行完了。** Clean Architecture（domain/application/infrastructure）を解体し、core/ agent/ gateway/ observability/ store/ fenghuang/ ollama/ mcp/ の機能別モジュール構成に移行完了。
- DI は `bootstrap.ts` に集約している。
- テストは `bun test` で実行可能。
- **Default モードを廃止し、ポーリングモードに一本化。** judge/cooldown/batching 等の従来フローを削除し、コードベースを大幅に簡素化。
- AI 推論は OpenCode SDK 経由。プロバイダとモデルは環境変数で設定可能。本筋エージェント: `OPENCODE_PROVIDER_ID`（デフォルト: `github-copilot`）/ `OPENCODE_MODEL_ID`（デフォルト: `big-pickle`）。LTM: `LTM_PROVIDER_ID`（フォールバック: `OPENCODE_PROVIDER_ID` -> `github-copilot`）/ `LTM_MODEL_ID`（デフォルト: `gpt-4o`）。
- **ポーリングモード**: `AgentRunner` が 1 回の `promptAsync()` で AI にバッファをポーリングさせる。全イベントを SQLite `event_buffer` テーブルに書き込み、AI が `event-buffer` MCP ツールで消費。1 セッションで全イベントを処理するためプロンプト課金を節約。
- セッションは SQLite `sessions` テーブルに永続化している。**セッション自動ローテーション: 48 時間（`SESSION_MAX_AGE_HOURS` で変更可）経過後にセッションを削除・再作成し、トークン蓄積を防止。**
- ブートストラップコンテキストはオーバーレイ方式で読込む: `data/context/` -> `context/` のフォールバック。書き込みは常に `data/context/` に行う。
- チャンネル設定は `data/context/channels.json` -> `context/channels.json` のフォールバックで管理する。
- **MCP サーバーは 3 プロセス構成。** `core-server.ts`（Discord 操作 + メモリ管理 + スケジュール管理 + イベントバッファ + LTM）が `type: "local"` で起動。`code-exec-server.ts`（コード実行）が `type: "local"` で起動。`minecraft/server.ts`（Minecraft 操作、`MC_HOST` 設定時のみ）は `type: "remote"` で独立 HTTP プロセスとして接続。
- **Heartbeat 自律行動システム: 1分間隔チェックループで due なリマインダーを検知し、AI セッションを起動して自律行動する。**
- **memory MCP サーバーで MEMORY.md / SOUL.md（読み取り専用） / LESSONS.md / 日次ログの構造化された読み書きが可能。**
- **`evolve_soul` ツールを廃止し、LESSONS.md に一本化。** SOUL.md はペルソナ定義に専念させ、「学んだこと」セクションを削除。既存エントリは guild LESSONS.md にマイグレーション済み。
- **Guild 跨ぎコンテキスト分離: 人格は全 Guild 共通、記憶（MEMORY, LESSONS, 日次ログ）は Guild ごとに分離。**
- **OpenCode SDK 組み込みの `webfetch` / `websearch` ツールを有効化済み。**
- **`llm_busy_sessions` ゲージメトリクスを追加。** `InstrumentedAiAgent.send()` でインフライトリクエスト数を `agent_type` ラベル付きでトラッキング。
- **Ollama をコンテナ化。** `compose.yaml` で `ollama` サービスを追加し、`vicissitude-net` ネットワークで `bot` と通信。初回起動時に `embeddinggemma` モデルを自動プル。`OLLAMA_BASE_URL` のデフォルトを `http://ollama:11434` に変更。
- **記憶システムマイグレーション方針を策定。** ファイルベースメモリ（MEMORY.md, LESSONS.md, 日次ログ）と LTM（fenghuang Episodes/SemanticFacts）の責任範囲を段階的に整理する計画を文書化（M5: 記憶システム統合）。
- **M5 Phase 1-3 完了。** LTM ファクトのシステムプロンプト注入、MEMORY.md スリム化、日次ログ再設計 + LESSONS.md 整理。
- **LTM 記録をホームチャンネルのみに限定。** `onHomeChannelMessage` 経由でホームチャンネルのメッセージのみを記録。bot 自身の発言もホームチャンネル内であれば記録。
- **LTM 自動統合スケジューラ（ハイブリッド方式）。** 30 分間隔で未統合エピソードからファクトを自動抽出する `ConsolidationScheduler` を追加。
- **Minecraft MCP サーバー（永続 HTTP プロセス）。** mineflayer + mineflayer-pathfinder を使用。`MC_HOST` 環境変数設定時のみ有効化。行動ツール、ジョブシステム、マルチセッション対応を実装済み。
- **M7 完了: 基盤層構築。** `src/core/`（types.ts, config.ts, functions.ts）に型定義・Zod 設定・純粋関数を集約。`src/store/`（db.ts, schema.ts, queries.ts）に Drizzle ORM + bun:sqlite で SQLite 統一永続化基盤を構築。
- **M8 完了: MCP サーバー統合。** `src/mcp/tools/` にツール定義を `registerXxxTools()` 関数として分離。`src/mcp/core-server.ts` が全ツールを組み立てる統合エントリポイント。event-buffer を SQLite ベースに移行。
- **M9 完了: エージェント抽象化。** `src/agent/`（profile.ts, runner.ts, router.ts, context-builder.ts, session-store.ts, profiles/conversation.ts）を作成。`PollingAgent` を `AgentProfile` + `AgentRunner` に分解。`SessionStore` で SQLite セッション永続化。
- **M10 完了: ブートストラップ + ゲートウェイ簡素化。** 4 ファイルのブートストラップを `bootstrap.ts` 1 ファイルに統合。`DiscordGateway` と `HeartbeatScheduler` / `ConsolidationScheduler` を `gateway/` に移動。`ConsoleLogger` / メトリクスを `observability/` に統合。旧 `domain/`, `application/` を削除。
- **M11 完了: クリーンアップ + ドキュメント更新。** `infrastructure/` を解体し、`fenghuang/`, `ollama/`, `agent/mcp-config.ts` に移動。旧 MCP サーバー（discord/memory/schedule/event-buffer/ltm）を削除。`mcp-config.ts` を `core-server.ts` 統合型に書き換え。全ドキュメントを新アーキテクチャに更新。
- `nr validate` (fmt:check + lint + check) および `bun test` が通る。
- Graceful shutdown（SIGINT/SIGTERM）実装済み。
- ペルソナ（SOUL.md）を全面刷新。Anti-AI-Slop ルール、会話参加判断基準、感情表現パターンを追加。
- **画像添付ファイルサポートを実装済み。** 対応 MIME タイプ: `image/png`, `image/jpeg`, `image/gif`, `image/webp`。

## 3. 確定済み方針

1. 人格名は「ふあ」。
2. TypeScript + Bun ランタイム。
3. 責務別フラットモジュール構成（Pure DI）。
4. DI コンテナなし。
5. MCP サーバーは独立プロセスとして 3 プロセス構成（core / code-exec / minecraft）。
6. `STATUS.md` は作業ごとに更新する。
7. AI がイベントバッファをポーリングし、自律的に応答判断・送信する（ポーリングモード一本化）。
8. Heartbeat システムで定期的な自律行動を実行する（interval / daily スケジュール対応）。
9. スケジュール管理は MCP ツール経由で通常会話からも変更可能。
10. メモリ管理は専用 MCP サーバー経由で行い、安全策（バックアップ、サイズ上限、append-only）を適用。

## 4. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期的にスローする（戻り値は `Promise<AgentResponse>`）。`.catch()` のみでハンドリングする呼び出し元が増えた場合は `Promise.reject()` に変更が必要。
- Ollama コンテナのイメージタグが `latest` 固定。再現性向上のためバージョン固定を将来的に検討。

## 5. 直近タスク

### アーキテクチャ再設計 (PLAN.md v2)

1. ~~M7: 基盤層 — core/ 型・設定・関数 + store/ SQLite 永続化~~ **完了**
2. ~~M8: MCP サーバー統合 — 5 MCP サーバーのツール分離 + core-server 統合エントリポイント~~ **完了**
3. ~~M9: エージェント抽象化 — AgentProfile + AgentRunner 分解 + SQLite セッション永続化~~ **完了**
4. ~~M10: ブートストラップ + ゲートウェイ簡素化~~ **完了**
5. ~~M11: クリーンアップ + ドキュメント更新~~ **完了**

### 過去の完了タスク（M1-M6 + Minecraft）

- ~~M1-M6~~ **完了** — Clean Architecture 移行、品質強化、堅牢性、機能拡張、記憶システム統合、Minecraft 拡張

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. ~~code-exec のサンドボックス欠如による RCE リスク~~ **対策済み** — Podman コンテナ化（ネットワーク遮断、読み取り専用 rootfs、全ケーパビリティ削除、メモリ/CPU/PID 制限）。

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
