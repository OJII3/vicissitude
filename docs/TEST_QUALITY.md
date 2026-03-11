# TEST_QUALITY.md

## 1. 目的

この文書は、Vicissitude におけるテスト品質の評価軸と、最初に自動化する集計方法を定義する。

狙いは「テスト数が多い」「カバレッジが高い」だけで安心しないことにある。
良いテストは、壊れた変更を検出し、原因が追いやすく、運用で回し続けられる。

## 2. 評価軸

テスト品質は次の 4 系統で見る。

1. `信頼性`
   - 失敗率: 実行テスト数に対する失敗数の割合
   - フレーク率: 同一リビジョン再実行で結果が変動した割合
   - スキップ率: 保留中テストの割合
2. `検出力`
   - 行カバレッジ
   - 関数カバレッジ
   - 重要シナリオ網羅率: 主要ユースケースと異常系のマッピング充足率
   - 本番流出率: 後から見つかった不具合のうち、事前テストで防げなかった割合
3. `実行性`
   - 総実行時間
   - 遅いテストファイル上位
   - リトライ/再実行率
4. `保守性`
   - 変更 1 件あたりのテスト修正量
   - 複雑なセットアップを要するテストの比率
   - 失敗時の診断容易性

## 3. まず自動化する指標

2026-03-12 時点では、Bun 標準出力だけで安定して取れる指標から始める。

- `tests_total`
- `assertions_total`
- `test_failures_total`
- `test_skipped_total`
- `test_failure_rate`
- `test_pass_rate`
- `test_duration_seconds`
- `test_line_coverage`
- `test_function_coverage`
- `slowest_test_files_top10`
- `lowest_line_coverage_files_top10`
- `flake_rate` (`nr test:quality:flake` 実行時)
- `flaky_test_files_top10` (`nr test:quality:flake` 実行時)
- `flaky_test_cases_top10` (`nr test:quality:flake` 実行時)

これらは `nr test:quality` で生成する。
`nr test:quality` はテストが失敗してもサマリ生成までは続行し、最後に非 0 で終了する。
フレーク集計を行う場合は `nr test:quality:flake` を使う。

出力先:

- `artifacts/test-quality/junit.xml`
- `artifacts/test-quality/coverage/lcov.info`
- `artifacts/test-quality/summary.json`
- `artifacts/test-quality/summary.md`
- `artifacts/test-quality/history.ndjson`
- `stdout` にも `component="test-quality"` の 1 行 JSON サマリを出力する（Grafana/Loki 用）

`nr test:quality:flake` は `bun test --rerun-each=5` を使い、同じ `file + test name + line` の結果が pass/fail に揺れたものを flaky とみなす。
回数は `TEST_FLAKE_RUNS` 環境変数で上書きできる。
flake 専用サマリは `junit-flake.xml` だけを入力に使い、通常の `junit.xml` / `coverage/lcov.info` は混在させない。

## 4. まだ自動化しないが追うべき指標

次は履歴蓄積が必要なので、初回導入では定義だけ置く。

- `escaped_defect_rate`
  - バグ修正 PR ごとに「事前テストで検出済みか」を記録して集計する
- `critical_scenario_coverage`
  - `docs/` または test matrix で主要シナリオ一覧を管理し、対応テストを紐付ける
- `test_rework_cost`
  - 機能変更 PR でテスト側 diff 量と壊れ方を観察する

## 5. 運用ルール

日常運用では次を確認する。

1. `test_failure_rate` は 0 を維持する
2. `test_duration_seconds` の悪化を追う
3. `slowest_test_files_top10` から重いテストを定期的に潰す
4. `lowest_line_coverage_files_top10` から重要なのに薄い領域を埋める
5. `nr test:quality:flake` を定期実行し、`flake_rate` を 0 に近づける
6. バグ修正時は「対応する再現テストを先に書けたか」を記録する

Grafana を使う場合:

- `monitoring/grafana-dashboard.json` の Test Quality セクションをインポートする
- Loki で `component="test-quality"` の JSON ログが見えることを確認する
- 継続収集したい場合は `artifacts/test-quality/history.ndjson` を Loki/Promtail の収集対象へ入れる
- 長期の推移は Loki 上の `failure_rate`, `line_coverage`, `function_coverage`, `flake_rate`, `duration_seconds` を見る

## 6. 解釈上の注意

- 行カバレッジ単独で品質を判定しない
- 失敗率 0 でも、重要変更で落ちるべきテストがないなら品質は高くない
- 現在の Bun LCOV では分岐カバレッジが安定して取れないため、当面は行/関数カバレッジを使う
- フレーク率は履歴なしでは見えない。単発実行結果だけで「安定」と判断しない
