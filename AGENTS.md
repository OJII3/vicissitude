# Vicissitude Agent Instructions

## 基本方針

- 日本語で応答する。
- ユーザーの要求・要件が不明瞭な場合は掘り下げ、不明瞭な点を解消してから進める。
- 変更前に関連する仕様・ドキュメント・既存実装を確認し、作業計画を立てる。
- 実装は YAGNI / KISS / DRY を優先し、不要な後方互換パスやフォールバックを追加しない。
- TypeScript / JavaScript プロジェクトのスクリプト実行は `nr` を使う。ただし `bun test` など Bun の予約コマンドを直接使う必要がある場合は例外とする。

## プロジェクト概要

Discord bot「ふあ(hua)」のプロジェクト。Bun, TypeScript, OpenCode で動作する。

## ドキュメント導線

1. `README.md`: 要件定義・仕様
2. `context/`: ペルソナ定義・会話ルール・行動指針

## コマンド

- `nr lint:fix` — Lint 自動修正 (`oxlint --fix`)
- `nr fmt` — フォーマット (`oxfmt`)
- `nr validate` — fmt:check + lint + check を一括実行
- `nr test` — 全テスト実行
- `nr test:spec` — 仕様テスト (`*.spec.ts`) のみ実行
- `nr test:unit` — ユニットテスト (`*.test.ts`) のみ実行
- `nr auto-triage:codex` / `:codex:once` — Codex 版 auto-triage（ループ / 1 回）
- `nr auto-triage:claude` / `:claude:once` — Claude 版 auto-triage（ループ / 1 回）
- `nr deploy` — 依存インストール・Web UI ビルド・インスタンス再起動を一括実行

## デプロイ

- ソースコード・依存変更後: `nr deploy` で再デプロイする。

## 開発ワークフロー（superpowers ハーネス）

ブレインストーミング・計画・実装・レビュー・デバッグ・ブランチ完了の各フェーズは **superpowers スキルに委譲する**。Codex 環境でも superpowers スキルが利用可能なため、タスクを受けたらいきなり実行に入らず、まず該当するスキルを起動する。

| フェーズ       | superpowers スキル                                                         |
| -------------- | -------------------------------------------------------------------------- |
| アイデア探索   | `brainstorming`                                                            |
| 計画策定       | `writing-plans`                                                            |
| 実装           | `subagent-driven-development`（同一セッション）/ `executing-plans`（並列） |
| テスト駆動     | `test-driven-development`                                                  |
| デバッグ       | `systematic-debugging`                                                     |
| コードレビュー | `requesting-code-review` / `receiving-code-review`                         |
| 完了確認       | `verification-before-completion`                                           |
| ブランチ完了   | `finishing-a-development-branch`                                           |

サブエージェントが使えない環境では、同じ役割境界・情報境界をメインエージェント自身が守って各フェーズを進める。以下はプロジェクト固有の制約であり、superpowers の手順に上書き・追加して適用する。

## テストの分類（プロジェクト規約）

仕様テストとユニットテストをファイル拡張子で区別する。

| 種別           | ファイル名  | 目的                                                                                          |
| -------------- | ----------- | --------------------------------------------------------------------------------------------- |
| 仕様テスト     | `*.spec.ts` | 公開 API の振る舞い・契約を検証。実装詳細に依存しない（ブラックボックス）。実装前に書く。     |
| ユニットテスト | `*.test.ts` | 内部ロジック・分岐・エッジケースを検証。実装に密結合で OK（ホワイトボックス）。実装後に書く。 |

**配置ルール:**

- 仕様テスト (`*.spec.ts`): トップレベルの `spec/` ディレクトリに、`src/` のディレクトリ構造をミラーして配置する。
- ユニットテスト (`*.test.ts`): ソースファイルと同じディレクトリに co-locate する。

```text
spec/agent/
  session-store.spec.ts     # 仕様テスト（公開 API 契約）

src/agent/
  session-store.ts          # 実装
  session-store.test.ts     # ユニットテスト（内部ロジック詳細）
```

**境界ルール:**

| 観点                 | `*.spec.ts`                  | `*.test.ts`                    |
| -------------------- | ---------------------------- | ------------------------------ |
| テスト対象           | 公開インターフェース・ポート | 内部関数・プライベートロジック |
| モック対象           | 外部依存（DB, API 等）のみ   | 内部依存もモック可             |
| リファクタで壊れるか | 壊れてはいけない             | 壊れてよい                     |
| 書くタイミング       | 実装前（TDD）                | 実装後                         |

リファクタ時は `*.spec.ts`（公開契約）のみを基準に検証する。`*.test.ts` は実装詳細に縛られるため、リファクタで壊れても構わない。

## コードレビュー（プロジェクト追加）

superpowers の `requesting-code-review` を基本とする。加えて、AI キャラクター「ふあ」のプロンプト設計・ツール構成・マルチエージェント構成・キャラクター一貫性に関わる変更では、`.claude/agents/agent-architecture-reviewer.md` の観点でキャラクター品質も検証する。

## Issue 運用ルール

- 作業中に課題・改善点・技術的負債を発見したら、その場で GitHub Issue を立てる。後回しにしない。
- レビューで指摘した項目のうち、今回の PR で修正しなかったものは必ず Issue に残す。
- Issue はまとめすぎず、トピックごとに小分けにする（1 Issue = 1 トピック）。
- 重要な判断が必要な課題には `help wanted` ラベルを付ける。

## Git と PR

- main ブランチに直接コミット・push しない。hotfix も含め、必ずブランチを切って PR 経由でマージする。
- 専用 worktree または作業ブランチで作業している場合は、そのブランチをそのまま使う。
- コミットメッセージは Conventional Commits 形式で書く。要約は日本語にする（例: `fix(agents): コミット規約を明確化する`）。`scope` は必要な場合のみ付ける。
- 変更後は検証を実行し、成功したら必ずコミットする。コミット後は push し、プルリクエストを作成する。
- コミット・push・PR 作成・マージの前に、追加の確認待ちで停止しない。
- マージはスカッシュマージし、マージ後にリモートブランチを削除する: `gh pr merge <number> --squash --delete-branch`。

## auto-triage

- `auto-triage` 実行時は `.claude/skills/auto-triage/SKILL.md` を必ず読む。
- 1 回の実行で処理する GitHub Issue または main CI 失敗は 1 件だけにする。
- main CI 失敗がある場合は Issue より先に処理する。
- `help wanted` ラベル付き Issue は対象から除外する。高レベル設計判断が必要な Issue は、理由をコメントして `help wanted` を付け、別の Issue を選ぶ。
- 完了前に `nr validate` と `nr test` を実行し、結果を報告に含める。

## 完了宣言ルール

- 「完了」「修正済み」「テスト通過」を主張するには、**そのメッセージ内で実行した検証証拠が必須**。前回の実行結果や「通るはず」は証拠にならない。
- 実装の報告には `nr check` / `nr lint`（または `nr validate`）の実行結果を含める。
- 実行できなかった検証がある場合は、理由を明記する。
