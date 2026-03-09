# STATUS.md

## 1. 最終更新

- 2026-03-09
- 更新者: claude-code
- ブランチ: feat/m12a-minecraft-sub-brain

## 2. 現在の真実（Project Truth）

- **モジュール構成移行完了（M7-M11）。** `core/` `agent/` `gateway/` `observability/` `store/` `fenghuang/` `ollama/` `mcp/` の機能別構成。DI は `bootstrap.ts` に集約。
- **ポーリングモード一本化。** `AgentRunner` が SQLite `event_buffer` にイベントを書き込み、AI が MCP ツールで消費。セッション自動ローテーション（デフォルト 48h、`SESSION_MAX_AGE_HOURS` で変更可）。
- **MCP サーバー 4 プロセス構成。** core（Discord + メモリ + スケジュール + イベントバッファ + LTM + MC ブリッジ）、code-exec、minecraft（`MC_HOST` 設定時のみ）、mc-sub-bridge（サブブレイン用ブリッジ）。
- **Minecraft サブブレイン（M12a）。** メインブレインとは独立した AgentRunner で動作。30秒間隔ポーリング。SQLite ベースの Event Bridge でメインブレインと通信。`config.minecraft` 存在時のみ起動。
- **Heartbeat 自律行動。** 1 分間隔チェックで due リマインダーを検知し AI セッションを起動。
- **LTM（fenghuang）。** ホームチャンネルのみ記録。30 分間隔自動統合。ファクトをシステムプロンプトに注入。
- **Guild コンテキスト分離。** 人格は共通、記憶（MEMORY, LESSONS, 日次ログ）は Guild ごと。
- **Minecraft MCP。** mineflayer ベース。行動ツール、ジョブシステム、マルチセッション対応。ライフサイクル修正済み（HTTP サーバー先行起動 → `/health` で readiness 確認 → bot 遅延接続）。
- **Ollama コンテナ化。** `compose.yaml` で `ollama` サービスを運用。`embeddinggemma` モデル自動プル。
- **画像添付サポート。** `image/png`, `image/jpeg`, `image/gif`, `image/webp`。
- **Lint 依存方向ルール。** `no-restricted-imports` の overrides で ARCHITECTURE.md の依存方向マトリクスを静的に強制。`import/first`, `import/no-mutable-exports`, `import/no-anonymous-default-export` も追加。
- `nr validate` (fmt:check + lint + check) 通過。Graceful shutdown 実装済み。

## 3. 確定済み方針

1. 人格名は「ふあ」。TypeScript + Bun ランタイム。
2. 責務別フラットモジュール構成（Pure DI、コンテナなし）。
3. MCP サーバーは独立プロセス 4 構成（core / code-exec / minecraft / mc-sub-bridge）。
4. AI がイベントバッファをポーリングし自律応答（ポーリングモード一本化）。
5. Heartbeat で定期自律行動（interval / daily）。スケジュールは MCP ツール経由で変更可。
6. メモリ管理は MCP 経由。安全策（バックアップ、サイズ上限、append-only）適用。
7. `STATUS.md` は作業ごとに更新する。

## 4. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期スロー（`.catch()` のみの呼び出し元が増えたら `Promise.reject()` に変更要）。
- Ollama イメージタグ `latest` 固定。バージョン固定を将来検討。
- `HeartbeatScheduler` / `ConsolidationScheduler` の二重タイムアウトで最悪 tick 時間が 2 倍（6 分 / 20 分）。
- 旧テスト（Guild 部分成功/失敗、`InstrumentedAiAgent`、`GuildRoutingAgent`）が新構成に未移植。
- ~~`OllamaEmbeddingAdapter` テストが `fetch` に URL オブジェクトが渡される件で失敗中。~~ **修正済み** — テスト側で `toString()` 比較に変更。

## 5. 直近タスク

- M7-M11 全完了。PR #93 マージ済み。
- Minecraft MCP ライフサイクル修正完了（PR #94）: `/health` エンドポイント追加、起動順序変更、タイムアウト時の kill 廃止。
- M12a Minecraft サブブレイン基盤完了: ContextBuilderPort 抽象化、MC Bridge テーブル、MCP ブリッジツール、サブブレイン専用 MCP サーバー、Minecraft エージェントプロファイル、タイマーベース EventBuffer、MinecraftContextBuilder、Bootstrap 統合。
- 未移植テストの追加。
- M12b 以降: サブブレインの高度な行動パターン、メインブレインとの連携強化。

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. ~~code-exec RCE リスク~~ **対策済み** — Podman コンテナ化。

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
