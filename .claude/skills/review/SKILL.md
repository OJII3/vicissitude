---
description: "Use when reviewing changed code — fix trivial issues directly and create GitHub Issues for larger concerns."
user_invokable: true
---

コードレビューの orchestrator スキル。4つのレビューサブエージェント（`.claude/agents/`）を並列起動し、結果を統合して **即修正** または **Issue 起票** に振り分ける。

## Phase 1: レビュー対象の特定

### デフォルト: git diff ベース

1. `git diff main...HEAD --name-only` で変更ファイル一覧を取得
2. `git diff main...HEAD` で差分内容を取得

### 引数指定

ユーザーがファイルパスやディレクトリを指定した場合は、そのスコープをレビュー対象とする。

## Phase 2: サブエージェント並列起動

以下の 4 エージェントを **Agent ツール（general-purpose）で並列に** 起動する。各エージェントには Phase 1 で取得した diff 内容と変更ファイル一覧を渡す。

| エージェント                  | 観点                                         |
| ----------------------------- | -------------------------------------------- |
| `correctness-reviewer`        | バグ、型安全性、ロジックエラー、エッジケース |
| `spec-compliance-reviewer`    | README.md / `*.spec.ts` との仕様整合性       |
| `design-reviewer`             | YAGNI/KISS/DRY、既存パターンとの一致         |
| `agent-architecture-reviewer` | AIキャラクターとしてのエージェント設計品質   |

各エージェントはリードオンリー（コード変更しない）。問題の検出と報告のみ行う。

### 起動方法

- Agent ツールの `name` に各エージェント名を設定し、4つ並列で呼び出す
- `prompt` に `.claude/agents/{name}.md` の内容全文と diff 内容を含める
- `model: sonnet` を指定する

## Phase 3: 結果統合と振り分け

4 エージェントの報告を受け取ったら、全指摘を統合し、以下の 2 カテゴリに振り分ける。

### A. 即修正（その場で直す）

以下の条件を **すべて** 満たすもの:

- 修正の意図が明確で、判断に迷いがない
- 変更が局所的（影響範囲が修正箇所のみ）
- 仕様変更・設計変更を伴わない

例: typo、lint 違反、未使用 import 削除、明らかなバグ修正、命名の不統一

### B. Issue 起票（GitHub Issue を作成する）

以下のいずれかに該当するもの:

- 要件変更や大きな仕様変更を伴う
- 修正のスコープが今の作業と大きく異なる
- 複数のアプローチがあり、判断が必要
- 技術的負債として記録すべき

Issue は `gh issue create` で作成する。1 Issue = 1 トピック。
重要な判断が必要なものには `help wanted` ラベルを付ける。

### 判定に迷う場合

サブエージェントの指摘について即修正か Issue かの判断に迷う場合は、`AskUserQuestion` でユーザーに確認する。

## Phase 4: 実行

1. **即修正**: 該当箇所を直接修正する
2. **検証**: `nr validate` で壊れていないことを確認する
3. **Issue 起票**: 該当する問題を `gh issue create` で起票する

## Phase 5: 報告

```
## レビュー結果

### 即修正した項目
- [ファイル:行] 内容（修正済み）
- ...

### 検証結果
nr validate の出力を貼る

### Issue 起票した項目
- #<number>: タイトル — 理由
- ...

### 問題なし
（全エージェントが問題なしと報告した場合）
```

即修正しなかった指摘のうち、Issue にも起票しなかったものがあってはならない。`/review` で発見した問題は、即修正するか Issue に残すかのいずれかに必ず振り分ける。

## 制約

- Phase 2 → 3 → 4 → 5 の順で進める。フェーズを飛ばさない。
- サブエージェントの指摘を鵜呑みにしない。統合時に妥当性を判断し、false positive は除外する。
- 即修正したら必ず `nr validate` で検証し、Phase 5 報告に出力を含める。
- 問題がなければ「問題なし」と簡潔に報告する。過剰に褒めない。
