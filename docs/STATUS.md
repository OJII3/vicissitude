# STATUS.md

## 1. 最終更新

- 2026-03-13
- 更新者: claude-code
- ブランチ: main

## 2. 現在の状態

- M7-M12d 全マイルストーン完了。責務別フラットモジュール構成で稼働中。
- Minecraft エージェント（サブブレイン）デプロイ済み（2026-03-10）。
- メトリクス充実化: トークンメトリクス（3個）+ MC メトリクス（3個）追加（合計 17 個）。
- Grafana ダッシュボードを更新し、壊れていた `judge_requests_total` パネルを LTM パネルへ置換、未反映だったトークン系・MC 系メトリクスを追加。
- M13a 要件整理を実施。Minecraft エージェントの不足機能を整理しドキュメント化。
- M13c 実行安全性ルールを整理。危険時プリエンプション、ジョブ再試行制限、失敗分類、Discord 通知条件をドキュメント化。
- M13c 実装（部分完了）:
  - 完了: 高優先度イベントでの brain wake 通知経路、ジョブ失敗分類（5 類型）、同系統ジョブ連続失敗時のクールダウン、`get_job_status` のクールダウン表示。
  - 未実装: stuck 判定、Discord 自動通知、クールダウン/再試行の詳細メトリクス。
- fenghuang 外部パッケージを `src/ltm/` としてモノレポに統合完了。StoragePort 廃止、LLMPort→LtmLlmPort リネーム、全テスト移行済み。
- `nr validate` 通過。`bun test` は 715 テスト pass（0 fail）。
- テスト品質:
  - `docs/TEST_QUALITY.md` + `nr test:quality` + `nr test:quality:flake` で JUnit / LCOV / flake rate を集計可能。
  - CI に Test Quality ワークフロー追加済み（PR ごと + main push + 週次 flake 検出）。
  - `monitoring/grafana-dashboard.json` に Test Quality セクション追加済み。
  - GitHub Actions のハッシュピン留め適用済み（PR #124, #125）。
  - 未テストモジュール 4 件にユニットテスト追加済み（PR #127: `ConsolidationScheduler`, `LtmConversationRecorder`, `ConsoleLogger`, `attachment-mapper` 計 27 件）。
  - CI テスト汚染修正済み（PR #128: `mock.module` → コンストラクタインジェクション）。
- 旧テスト移植:
  - `GuildRouter`: テスト完備（`router.test.ts` 8 件）。
  - `InstrumentedAiAgent`: テスト完備（`instrumented-agent.test.ts` 11 件）。
- `actions/survival/` へ責務分割し、`survival.ts` の max-lines 問題を解消した。
- Discord / Minecraft の AgentRunner を長寿命セッションの終了監視型へ寄せる作業を開始。
- OpenCode 長寿命セッション監視の停止ハングを修正。

## 3. 既知のバグ・要修正事項

- `GuildRouter.send()` がエラーを同期スロー（`.catch()` のみの呼び出し元が増えたら `Promise.reject()` に変更要）。
- Ollama イメージタグ `latest` 固定。バージョン固定を将来検討。
- `HeartbeatScheduler` / `ConsolidationScheduler` の二重タイムアウトで最悪 tick 時間が 2 倍（6 分 / 20 分）。
- 危険時再判断は wake file による早期再開まで実装。完全なイベント直結ではなく、ファイルポーリングに依存する。
- stuck 判定、再試行制御の詳細メトリクス、Discord 通知自動化はまだ未実装。
- テスト品質は失敗率・時間・行/関数カバレッジ・フレーク率までは自動集計済みだが、本番流出率は未導入。残りのテスト未実装モジュールは `DiscordGateway`（優先度 中）と `bootstrap.ts`（優先度 低）。
- Grafana 上の Test Quality 可視化はダッシュボード JSON まで更新済みだが、実際の Loki 取り込み設定は環境側確認が必要。

## 4. 直近タスク

- `M13c` 継続: stuck 判定、Discord 自動通知をコードへ反映する。
- クールダウン / 再試行制御を追加メトリクスとログで追えるようにする。
- `M13e`: 正式アカウントログイン設計。
- テストが存在しない残りモジュールへのテスト追加（残: `DiscordGateway`）。
- `nr test:quality` / `nr test:quality:flake` の履歴蓄積導線を作り、重要シナリオ網羅率へ拡張する。
- Grafana サーバーへ更新済みダッシュボード JSON を反映し、Test Quality パネルの Loki クエリが環境ラベルで動くか確認する。
- 運用観察: Minecraft エージェントの実際の動作確認・チューニング。

## 5. ブロッカー

- なし。
