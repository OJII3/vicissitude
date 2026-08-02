# Conversation Scenario Corpus

Phase 2 の batch パラメータと宛先推定品質を人手評価するための会話シナリオ集。
設計: `docs/superpowers/specs/2026-07-29-phase-2-conversation-cognition-design.md` §6

## 形式

- `conversations/NN-<name>.json` が 1 ファイル = 1 scenario
- スキーマは `scenario.ts` の `conversationScenarioSchema`。`corpus.spec.ts` が全ファイルを検証する

## ラベルの意味

- `addressee` — 評価対象となるトリガーメッセージの宛先。明示的な宛先を持たない後続メッセージは直前のトリガーを引き継ぐ
- `expectedAction` — シナリオ終端でキャラクターに期待する行動（`reply` / `silence` / `defer`）
- `referencedMessageIds` — 正しい応答が踏まえているべきメッセージの ID（silence なら空）
- `maxWaitMs` — トリガーから応答までの許容最大待機時間。`batchWindow` / `maxWait` の設定値はこのラベルを根拠に決める。silence では `null`
- `misinterventionSeverity` — このシナリオで誤介入（不要な発言・誤った会話への参加）をした場合の重大度。応答内容の品質（知ったかぶり等）は別軸で評価する
- `notes` — 評価者向けの補足。何が正解で何が失敗かの判断基準

## 評価の運用

初期は人手評価のみ。LLM による品質数値化や `spec/e2e/` ハーネスへの自動接続は Phase 2B 以降に判断する。

## scenario の追加方法

1. `conversations/` に連番の JSON を追加する
2. `pnpm exec vitest run spec/corpus/corpus.spec.ts` でスキーマ検証を通す
