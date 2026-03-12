# STATUS.md

## 1. 最終更新

- 2026-03-12
- 更新者: codex
- ブランチ: fix/opencode-session-watch-race

## 2. 現在の状態

- M7-M12d 全マイルストーン完了。責務別フラットモジュール構成で稼働中。
- Minecraft エージェント（サブブレイン）デプロイ済み（2026-03-10）。
- メトリクス充実化: トークンメトリクス（3個）+ MC メトリクス（3個）追加（合計 17 個）。
- Grafana ダッシュボードを更新し、壊れていた `judge_requests_total` パネルを LTM パネルへ置換、未反映だったトークン系・MC 系メトリクスを追加。
- M13a 要件整理を実施。現行の単一 Minecraft AgentRunner を、将来的にオーケストレータ + `Observer` / `Planner` / `Executor` / `Critic` / `Social` へ分割する方針をドキュメント化。
- M13c 実行安全性ルールを整理。危険時プリエンプション、ジョブ再試行制限、失敗分類、Discord 通知条件をドキュメント化。
- M13c 実装を開始。Minecraft MCP 側の高優先度イベントでメイン brain を早期 wake するファイル通知経路、ジョブ失敗クールダウン、`get_job_status` へのクールダウン表示を追加。
- `nr validate` 通過。`bun test` は 392 テスト pass。
- テスト品質評価の土台として `docs/TEST_QUALITY.md` を追加し、`nr test:quality` で JUnit + LCOV からサマリを生成できるようにした。
  - 最新計測値は CI アーティファクトまたは `PLAN.md` §5.1 を参照。
- `nr test:quality:flake` を追加し、`bun test --rerun-each` ベースで flake rate を集計できるようにした。
- `monitoring/grafana-dashboard.json` に Test Quality セクションを追加し、`component="test-quality"` の Loki JSON ログで failure rate / coverage / flake rate / duration を可視化できるようにした。
- `actions/survival/` へ責務分割し、`survival.ts` の max-lines 問題を解消した。
- `nr test:quality` / `nr test:quality:flake` の終了コード処理と入力分離を修正し、失敗時でもサマリ生成を継続しつつ broken build を見逃さないようにした。
- Discord / Minecraft の AgentRunner を、`promptAsync()` 完了待ちではなく長寿命セッションの終了監視型へ寄せる作業を開始。
- OpenCode 長寿命セッション監視の停止ハングを修正。abort 時に購読ストリームを即時解除し、停止・再起動が次イベント待ちで詰まらないようにした。

## 3. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期スロー（`.catch()` のみの呼び出し元が増えたら `Promise.reject()` に変更要）。
- Ollama イメージタグ `latest` 固定。バージョン固定を将来検討。
- `HeartbeatScheduler` / `ConsolidationScheduler` の二重タイムアウトで最悪 tick 時間が 2 倍（6 分 / 20 分）。
- 旧テスト（Guild 部分成功/失敗、`InstrumentedAiAgent`、`GuildRoutingAgent`）が新構成に未移植。該当コードの使用状況を確認し、移植または削除を判断する。
- 危険時再判断は wake file による早期再開まで実装。完全なイベント直結ではなく、ファイルポーリングに依存する。
- stuck 判定、再試行制御の詳細メトリクス、Discord 通知自動化はまだ未実装。
- テスト品質は失敗率・時間・行/関数カバレッジ・フレーク率までは自動集計済みだが、本番流出率は未導入。テストが存在しないモジュール（`ConsolidationScheduler`, `DiscordGateway`, `FenghuangConversationRecorder`, `ConsoleLogger`, `attachment-mapper`）の改善計画を `PLAN.md` §5.2 に記載。
- Grafana 上の Test Quality 可視化はダッシュボード JSON まで更新済みだが、実際の Loki 取り込み設定は環境側確認が必要。

## 4. 直近タスク

- `M13b`: subagent ベース認知アーキテクチャの入出力、使用ツール、起動条件、停止条件を設計する。
- `M13c` 継続: stuck 判定、再試行制御、失敗分類に応じた Discord 通知をコードへ反映する。
- クールダウン / 再試行制御を追加メトリクスとログで追えるようにする。
- テストが存在しないモジュールへのテスト追加（優先: `ConsolidationScheduler`, `FenghuangConversationRecorder`, `ConsoleLogger`）。
- 旧テスト（Guild, InstrumentedAiAgent, GuildRoutingAgent）の移植判断（使用状況確認 → 移植 or 削除）。
- `nr test:quality` / `nr test:quality:flake` の履歴蓄積導線を作り、重要シナリオ網羅率へ拡張する。
- Grafana サーバーへ更新済みダッシュボード JSON を反映し、Test Quality パネルの Loki クエリが環境ラベルで動くか確認する。
- 運用観察: Minecraft エージェントの実際の動作確認・チューニング。
- 更新後の Grafana ダッシュボードをインポートし、Prometheus の MC metrics scrape（既定 `:9092`）を確認する。

## 5. ブロッカー

- なし。
