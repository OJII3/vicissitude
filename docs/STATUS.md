# STATUS.md

## 1. 最終更新

- 2026-03-07
- 更新者: AI
- ブランチ: main

## 2. 現在の真実（Project Truth）

- Clean Architecture への移行が完了し、main にマージ済み。
- domain / application / infrastructure の 3 層構成で、依存方向ルールは正しく守られている。
- DI は手動コンストラクタ注入（Pure DI）で `composition-root.ts` に集約している。
- テストは `bun test` で実行可能。
- **Default モードを廃止し、ポーリングモードに一本化。** judge/cooldown/batching 等の従来フローを削除し、コードベースを大幅に簡素化。
- AI 推論は OpenCode SDK 経由。プロバイダとモデルは環境変数で設定可能。本筋エージェント: `OPENCODE_PROVIDER_ID`（デフォルト: `github-copilot`）/ `OPENCODE_MODEL_ID`（デフォルト: `big-pickle`）。LTM: `LTM_PROVIDER_ID`（フォールバック: `OPENCODE_PROVIDER_ID` → `github-copilot`）/ `LTM_MODEL_ID`（デフォルト: `gpt-4o`）。
- **ポーリングモード**: `PollingAgent` が 1 回の `promptAsync()` で AI にバッファをポーリングさせる。全イベントを `FileEventBuffer` に JSONL で書き込み、AI が `event-buffer` MCP ツールで消費。1 セッションで全イベントを処理するためプロンプト課金を節約。
- セッションは `data/sessions.json` に JSON で永続化している。
- ブートストラップコンテキストはオーバーレイ方式で読込む: `data/context/` → `context/` のフォールバック。書き込みは常に `data/context/` に行う。
- チャンネル設定は `data/context/channels.json` → `context/channels.json` のフォールバックで管理する。
- MCP サーバーは `discord-server.ts`（Discord 操作）、`code-exec-server.ts`（コード実行）、`schedule-server.ts`（Heartbeat スケジュール管理）、`memory-server.ts`（メモリ・人格管理）、`event-buffer-server.ts`（イベントバッファ）、`ltm-server.ts`（長期記憶）の 6 つ。
- **Heartbeat 自律行動システム: 1分間隔チェックループで due なリマインダーを検知し、AI セッションを起動して自律行動する。**
- **memory MCP サーバーで MEMORY.md / SOUL.md / LESSONS.md / 日次ログの構造化された読み書きが可能。**
- **Guild 跨ぎコンテキスト分離: 人格は全 Guild 共通、記憶（MEMORY, LESSONS, 日次ログ）は Guild ごとに分離。**
- **OpenCode SDK 組み込みの `webfetch` / `websearch` ツールを有効化済み。**
- **`composition-root.ts` をリファクタリングし、`bootstrap-context.ts`（共有型）、`bootstrap-helpers.ts`（共有ヘルパー）、`bootstrap-agents.ts`（エージェントブートストラップ）に分割。**
- **`llm_busy_sessions` ゲージメトリクスを追加。** `InstrumentedAiAgent.send()` でインフライトリクエスト数を `agent_type` ラベル付きでトラッキング。
- **Ollama をコンテナ化。** `compose.yaml` で `ollama` サービスを追加し、`vicissitude-net` ネットワークで `bot` と通信。初回起動時に `embeddinggemma` モデルを自動プル。`OLLAMA_BASE_URL` のデフォルトを `http://ollama:11434` に変更。
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

1. `context/channels.json` にホームチャンネル ID を設定して動作確認する
2. テスト用 Discord サーバーでの E2E 検証
3. infrastructure 層のテストカバレッジ拡充

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
