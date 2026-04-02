---
description: "GitHub Issue を自動で選んで取り組み、レビュー・マージまで行う自律ワークフロー"
user_invokable: true
---

GitHub Issue の自動トリアージ・実装・マージを一連で行うスキル。

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

CLAUDE.md のワークフローに従って実装する。

1. `--worktree` モードで起動されている場合、worktree のブランチをそのまま使う。手動実行の場合は `git switch -c auto/<issue-number>-<short-description>` で作業ブランチを作成
2. Plan サブエージェントでタスク分解・スコープ特定
3. CLAUDE.md の「タスク別の呼び出しパターン」に従い、適切なパターンで実装:
   - 新機能: spec → verify → impl → test → verify
   - バグ修正: spec → impl → verify
   - リファクタ: verify → impl → verify
4. こまめにコミット

### 重要: Agent Teams ではなく Agent サブエージェントを使う

このスキルは非対話モード（`-p` フラグ）で実行される。CLAUDE.md の委譲ルールの非対話モード例外に基づき、**Agent Teams（`TeamCreate` + チームメイト）ではなく Agent サブエージェント（ブロッキング呼び出し）** を使用する。

```
# NG: チームメイト（非同期、stdout が途切れて watchdog kill される）
TeamCreate → Agent(team_name: "xxx", ...)  → end_turn → watchdog kill

# OK: サブエージェント（ブロッキング、結果が tool result で返る）
Agent(subagent_type: "general-purpose", prompt: "...")  → tool result で結果を受け取る
```

### サブエージェント呼び出し時の情報境界

CLAUDE.md の「Agent Team におけるチームメイトの情報境界」と同じルールを、サブエージェントのプロンプト構成に適用する。

| サブエージェント役割 | プロンプトに含めるもの                 | プロンプトに含めないもの        |
| -------------------- | -------------------------------------- | ------------------------------- |
| spec 役              | タスク説明・既存 `*.spec.ts`・plan出力 | 実装コード・`*.test.ts`         |
| impl 役              | `*.spec.ts`・型定義・スコープ          | `*.test.ts`・他モジュールの実装 |
| test 役              | 実装コード・`*.spec.ts`                | 他モジュール                    |
| verify 役            | `*.spec.ts` のパス・実行結果・plan出力 | 実装の中身                      |

### コミット責務

サブエージェントはコミットしない。コミットは auto-triage エージェント自身が行う。各サブエージェントの作業完了後にまとめてコミットすること。

## Phase 4: レビューとマージ

1. `/review` スキルを実行
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

### 起票した Issue（/review で発見）
- #<number>: <title>
```

## 制約

- 1 回の実行で取り組む Issue は **1 つだけ**
- `help wanted` をつけてスキップするのは **最大 3 回** まで。3 回スキップしたら「取り組める Issue なし」として終了
- main ブランチに直接コミットしない。必ず作業ブランチを切る
- マージ前に `nr validate` と `nr test` を実行し、出力を Phase 5 報告に含めること（完了宣言ルール準拠）
