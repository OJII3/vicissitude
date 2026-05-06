---
name: auto-triage
description: "GitHub Issue を自動で選んで取り組み、レビュー・マージまで行う自律ワークフロー"
---

GitHub Issue の自動トリアージ・実装・マージを一連で行うスキル。

## Phase 0: CI 失敗チェック

Issue 選定の前に、main ブランチの CI が失敗していないか確認する。

1. `gh run list --branch main --limit 5 --json status,conclusion,name,headSha,url` で最新の CI 実行結果を取得
2. `conclusion` が `failure` のランがある場合:
   - `gh run view <run-id> --log-failed` で失敗ログを確認
   - 作業ブランチ `auto/fix-ci-<short-description>` を作成
   - 失敗の原因を分析・修正し、PR を作成・マージする（Phase 3〜4 と同じ手順）
   - 修正完了後、Phase 1 に進む
3. CI が全て成功している場合はそのまま Phase 1 に進む

## Phase 1: Issue 選定

1. `gh issue list --state open --limit 20 --json number,title,labels,createdAt` で Issue 一覧を取得
2. `help wanted` ラベル付きの Issue は **除外** する（設計判断が必要なため）
3. 残りの Issue から 1 つ選ぶ。優先度:
   - `bug` ラベル > ラベルなし > `enhancement`
   - 同優先度なら古いものを優先
4. 選んだ Issue を `gh issue view <number>` で詳細確認

## Phase 2: スコープ判定

選んだ Issue の内容を分析し、以下を判定する:

### 高レベル設計判断が必要な場合

以下のいずれかに該当する場合は **`help wanted` ラベルを付けてスキップ** し、Phase 1 に戻って別の Issue を選ぶ:

- 公開 API の破壊的変更が必要
- 複数モジュールにまたがるアーキテクチャ変更
- 仕様が曖昧で要件の解釈に複数の選択肢がある
- 既存の spec テストの変更が必要（仕様変更を意味する）

スキップ時は Issue にコメントを残す:

```
gh issue comment <number> --body "自動トリアージ: 設計判断が必要なため help wanted を付与しました。理由: <具体的な理由>"
gh issue edit <number> --add-label "help wanted"
```

### 取り組める場合

Phase 3 に進む。

## Phase 3: 実装

AGENTS.md のワークフローに従って実装する。

1. 専用 worktree または作業ブランチで実行されている場合は、そのブランチをそのまま使う。main の場合は `git switch -c auto/<issue-number>-<short-description>` で作業ブランチを作成
2. 関連する仕様・ドキュメント・既存実装を確認し、作業計画を立てる
3. AGENTS.md と Codex の委譲ルールに従って実装する:
   - 新機能: 仕様確認・必要な仕様更新 → 実装 → テスト追加 → 検証
   - バグ修正: 根本原因調査 → 再現テストまたは確認手順作成 → 修正 → 検証
   - リファクタ: 既存挙動確認 → リファクタ → 仕様・テスト検証
4. 作業ブランチではこまめにコミット

### サブエージェント利用時の情報境界

Codex のサブエージェントを使う場合は、担当範囲・読み取り対象・編集対象を明確にし、不要な実装詳細を渡しすぎない。

### コミット責務

サブエージェントはコミットしない。コミットは auto-triage を実行している Codex エージェント自身が行う。各作業単位の完了後にまとめてコミットすること。

## Phase 4: レビューとマージ

1. `/review-pr` スキルを実行
2. レビューで指摘された即修正項目を修正
3. push して PR 作成: `gh pr create`
4. PR をスカッシュマージ: `gh pr merge <number> --squash --delete-branch`

## Phase 5: 報告

実行結果をログに出力する:

```
## Auto-Triage 結果

### 取り組んだ Issue
- #<number>: <title>

### スキップした Issue（help wanted 付与）
- #<number>: <title> — 理由: <reason>

### 作成した PR
- #<number>: <title> → merged

### 起票した Issue（/review-pr で発見）
- #<number>: <title>
```

## 制約

- 1 回の実行で取り組む Issue は **1 つだけ**
- `help wanted` をつけてスキップするのは **最大 3 回** まで。3 回スキップしたら「取り組める Issue なし」として終了
- main ブランチに直接コミットしない。必ず作業ブランチを切る
- マージ前に `nr validate` と `nr test` を実行し、出力を Phase 5 報告に含めること（完了宣言ルール準拠）
