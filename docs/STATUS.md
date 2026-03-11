# STATUS.md

## 1. 最終更新

- 2026-03-11
- 更新者: codex
- ブランチ: docs/m13c-safety-rules

## 2. 現在の状態

- M7-M12d 全マイルストーン完了。責務別フラットモジュール構成で稼働中。
- Minecraft エージェント（サブブレイン）デプロイ済み（2026-03-10）。
- メトリクス充実化: トークンメトリクス（3個）+ MC メトリクス（3個）追加（合計 17 個）。
- Grafana ダッシュボードを更新し、壊れていた `judge_requests_total` パネルを LTM パネルへ置換、未反映だったトークン系・MC 系メトリクスを追加。
- M13a 要件整理を実施。現行の単一 Minecraft AgentRunner を、将来的にオーケストレータ + `Observer` / `Planner` / `Executor` / `Critic` / `Social` へ分割する方針をドキュメント化。
- M13c 実行安全性ルールを整理。危険時プリエンプション、ジョブ再試行制限、失敗分類、Discord 通知条件をドキュメント化。
- `nr validate` 通過。計 342 テスト pass。

## 3. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期スロー（`.catch()` のみの呼び出し元が増えたら `Promise.reject()` に変更要）。
- Ollama イメージタグ `latest` 固定。バージョン固定を将来検討。
- `HeartbeatScheduler` / `ConsolidationScheduler` の二重タイムアウトで最悪 tick 時間が 2 倍（6 分 / 20 分）。
- 旧テスト（Guild 部分成功/失敗、`InstrumentedAiAgent`、`GuildRoutingAgent`）が新構成に未移植。
- Minecraft エージェントは依然として 30 秒ポーリング中心で、危険時の即時再判断経路はまだ未実装。
- ジョブの stuck 判定・クールダウンは設計済みだが、実装とメトリクス反映は未着手。

## 4. 直近タスク

- `M13b`: subagent ベース認知アーキテクチャの入出力、使用ツール、起動条件、停止条件を設計する。
- `M13c` 実装: 危険時プリエンプション、再計画条件、失敗時標準ハンドリングをコードへ反映する。
- stuck / クールダウン / 再試行制御をメトリクスとログで追えるようにする。
- 未移植テストの追加（旧 Guild テスト、InstrumentedAiAgent テスト等）。
- 運用観察: Minecraft エージェントの実際の動作確認・チューニング。
- 更新後の Grafana ダッシュボードをインポートし、Prometheus の MC metrics scrape（既定 `:9092`）を確認する。

## 5. ブロッカー

- なし。
