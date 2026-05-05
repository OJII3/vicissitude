# Memory Consolidation Architecture

## 目的

`packages/memory` の consolidation は、未統合エピソードから永続的な意味記憶を作成・更新する境界である。
この処理では LLM 呼び出し、ストレージ更新、FSRS レビューが発生するため、判断ロジックと副作用を混ぜない。

## 責務境界

- `ConsolidationPipeline`
  - ユースケースの流れだけを制御する。
  - 対象エピソードの取得、抽出戦略の選択、ファクト適用、エピソード統合済みマークを順に実行する。
- `ConsolidationExtractor`
  - LLM 呼び出しによるファクト抽出だけを担当する。
  - 既存ファクトがある場合は Predict-Calibrate、ない場合は直接抽出を使う。
- `ConsolidationEpisodeFinalizer`
  - FSRS review とエピソード統合済みマークを担当する。
- 契約
  - LLM から受け取る structured output の検証を担当する。
  - action、category、fact、keywords、existingFactId の前提条件をここで確定する。
- プロンプト構築
  - Episode と既存 SemanticFact から LLM 入力を作る純粋処理に限定する。
  - ユーザー由来の episode/fact/prediction は XML エスケープまたはタグで境界を作る。
- ファクト適用
  - SemanticFact の作成、重複判定、保存、更新、無効化を担当する。
  - LLM embedding と storage write はこの境界に閉じ込める。

## 契約

- `consolidate(userId)` は空でない userId のみ受け付ける。
- LLM structured output は `facts` 配列のみを入口とし、1 episode あたり最大 30 件までとする。
- `new` は `existingFactId` を持たない。
- `reinforce` / `update` / `invalidate` は `existingFactId` を必須にし、処理時点の active existing fact を参照しなければならない。
- fact は空文字を禁止し、最大 1000 文字とする。
- keywords は配列で、最大 10 件、各 keyword は最大 100 文字とする。
- ファクト重複は embedding 類似度 0.95 以上を同一内容として扱う。

## 副作用

- LLM 呼び出しは抽出フェーズに限定する。
- LLM embedding と storage write はファクト適用境界に限定する。
- 時刻は episode 処理コンテキストで 1 回だけ確定し、ファクト適用、invalidate、FSRS review、統合済みマークに同じ時刻を渡す。
- エピソードはファクト適用と FSRS review が終わった後に統合済みにする。
