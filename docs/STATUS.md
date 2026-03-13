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
- M13c 実装（完了）:
  - 高優先度イベントでの brain wake 通知経路、ジョブ失敗分類（5 類型）、同系統ジョブ連続失敗時のクールダウン、`get_job_status` のクールダウン表示。
  - Discord 自動通知: `death`/`kicked`/`disconnect` イベントを `AutoNotifier` がブリッジ DB に自動挿入（30 秒クールダウン付き）。
  - クールダウン/再試行メトリクス: `mc_cooldowns_total`, `mc_failure_streaks_total`, `mc_auto_notifications_total` を追加。
- M13d stuck 検知を実装（PR #132）。位置・インベントリ・体力の停滞検知 + 自動リカバリ（連続失敗 / 位置停滞 + 時間条件）。
- M13d 記憶再設計:
  - `MINECRAFT-PROGRESS.md` 新設（装備段階、拠点、探索範囲、主要資源、達成済み目標、プレイヤーメモ）。
  - `MINECRAFT-GOALS.md` を「現在の目標のみ」に簡素化。
  - `MINECRAFT-SKILLS.md` に前提条件・失敗パターンフィールドを追加。常時注入から除外（必要時のみ読む）。
  - `mc_read_progress`/`mc_update_progress` をエイリアスから独立ツールに変更。
- fenghuang 外部パッケージを `src/ltm/` としてモノレポに統合完了（PR #134）。
  - StoragePort 廃止 → SQLite 直接依存、LLMPort → LtmLlmPort リネーム、全テスト移行済み。
  - レビュー指摘 6 件修正: 型安全性向上（`Promise<Episode[]>`）、セグメント index バリデーション強化、キューサイズ事前チェック、embedding 検索の 2 段階最適化、FTS5 フォールバック限定化、フィールド長制限追加。
  - M14 LTM 強化ロードマップを PLAN.md に追加（FSRS 学習ループ、Fact 関連性フィルタリング、記憶システム統合、埋め込みロバスト性）。
- M14a FSRS 学習ループ統合:
  - `Retrieval.retrieve()` 実行時にヒットしたエピソードを自動で `review(rating: "good")` する。
  - `ConsolidationPipeline.consolidate()` でエピソード処理時に `review(rating: "good")` する。
  - `lastReviewedAt` が更新されることで、頻繁に参照されるエピソードの `retrievability` が高く維持される。
- M14b ファクト注入の関連性フィルタ:
  - `LtmFactReader.getRelevantFacts(guildId, context, limit)` を追加。
  - ハイブリッド検索（FTS5 テキスト + embedding コサイン類似度 + RRF スコアリング）で関連ファクトを選別。
  - カテゴリ多様性保証: 全カテゴリから最低 1 件 + 関連スコア上位で limit まで埋める。
  - `ContextBuilder` が日次ログをコンテキストヒントとして渡す。日次ログなしの場合は `getFacts()` にフォールバック。
  - ファクト数 ≤ limit の場合は全件返却（不要な embedding API 呼出回避）。
  - `OllamaEmbeddingAdapter` をコンテキスト層と LTM 記録層で共有化。
- M14c 記憶システム責務統合（Phase 2-3）:
  - Phase 2: MEMORY.md スリム化。ユーザー情報（名前・authorId・特徴）を全 MEMORY.md から削除し、LTM 参照ノートに置換。エピソード的情報（MC 進捗詳細）も LTM Episodes に委譲。Guild 固有 MEMORY.md をそのギルド固有のサーバー情報のみに限定。
  - Phase 3: 日次ログ保持期間（7 日）の `cleanup_old_logs` MCP ツール追加。SPEC.md に責務分離表を追加。
- `nr validate` 通過。`bun test` は 752 テスト pass（0 fail）。
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
- stuck 判定は実装済み（PR #132）。Discord 自動通知は death/kicked/disconnect のみ。LLM 判断通知（stuck、危険回避等）は `mc_report` 経由。
- LTM の既知の不足機能（M14 で対応予定）:
  - ~~FSRS `reviewCard()` が本番で呼ばれていない~~ → M14a で解消。retrieve/consolidate 時に自動 review。
  - ~~ContextBuilder が全 Fact を無条件注入。関連性フィルタリング未実装。~~ → M14b で解消。日次ログベースのハイブリッド検索で関連上位 N 件 + カテゴリ別最低 1 件を注入。
  - ~~3 つの独立した記憶システム（LTM, MEMORY.md/LESSONS.md, 日次ログ）が未統合。~~ → M14c で責務分離を整理。MEMORY.md スリム化 + 日次ログ保持期間定義。
  - 埋め込み次元のメタデータ管理なし。モデル変更時の互換性リスク。
- `data/fenghuang/` → `data/ltm/` のデータディレクトリ移行手順が RUNBOOK に未記載。
- テスト品質は失敗率・時間・行/関数カバレッジ・フレーク率までは自動集計済みだが、本番流出率は未導入。残りのテスト未実装モジュールは `DiscordGateway`（優先度 中）と `bootstrap.ts`（優先度 低）。
- Grafana 上の Test Quality 可視化はダッシュボード JSON まで更新済みだが、実際の Loki 取り込み設定は環境側確認が必要。

## 4. 直近タスク

- ~~`M14a`: FSRS 学習ループ構築~~ 完了。
- ~~`M14b`: Fact 注入時の関連性フィルタリング（ハイブリッド検索で上位 N 件のみ注入）。~~ 完了。
- ~~`M13c` 継続: Discord 自動通知をコードへ反映する。~~ 完了。
- ~~クールダウン / 再試行制御を追加メトリクスとログで追えるようにする。~~ 完了。
- `M13e`: 正式アカウントログイン設計。
- `data/fenghuang/` → `data/ltm/` 移行手順を RUNBOOK に追記。
- テストが存在しない残りモジュールへのテスト追加（残: `DiscordGateway`）。
- `nr test:quality` / `nr test:quality:flake` の履歴蓄積導線を作り、重要シナリオ網羅率へ拡張する。
- Grafana サーバーへ更新済みダッシュボード JSON を反映し、Test Quality パネルの Loki クエリが環境ラベルで動くか確認する。
- 運用観察: Minecraft エージェントの実際の動作確認・チューニング。

## 5. ブロッカー

- なし。
