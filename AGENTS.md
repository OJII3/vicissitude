# Vicissitude Agent Instructions

## 基本方針

- 日本語で応答する。
- 変更前に関連する仕様・ドキュメント・既存実装を確認し、作業計画を立てる。
- 実装は YAGNI / KISS / DRY を優先し、不要な後方互換パスやフォールバックを追加しない。
- TypeScript / JavaScript プロジェクトのスクリプト実行は `nr` を使う。ただし `bun test` など Bun の予約コマンドを直接使う必要がある場合は例外とする。

## Git と PR

- main ブランチに直接コミットしない。
- 専用 worktree または作業ブランチで作業している場合は、そのブランチをそのまま使う。
- コミットメッセージは Conventional Commits 形式で書く。要約は日本語にする。
  - 形式: `type(scope): 日本語の要約`
  - `scope` は必要な場合のみ付ける。
  - 例: `fix(agents): コミット規約を明確化する`
- 変更後は検証を実行し、成功したら必ずコミットする。
- コミット後は必ず push し、プルリクエストを作成する。
- PR 作成後は、指示されたワークフローでマージまで行う。auto-triage では `.agents/skills/auto-triage/SKILL.md` に従い、スカッシュマージしてリモートブランチを削除する。
- コミット・push・PR 作成・マージの前に、追加の確認待ちで停止しない。

## auto-triage

- `auto-triage` 実行時は `.agents/skills/auto-triage/SKILL.md` を必ず読む。
- 1 回の実行で処理する GitHub Issue または main CI 失敗は 1 件だけにする。
- main CI 失敗がある場合は Issue より先に処理する。
- `help wanted` ラベル付き Issue は対象から除外する。
- 高レベル設計判断が必要な Issue は、理由をコメントして `help wanted` を付け、別の Issue を選ぶ。
- サブエージェントはコミットしない。コミット、push、PR 作成、マージは auto-triage を実行しているエージェント自身が行う。
- 完了前に `nr validate` と `nr test` を実行し、結果を報告に含める。

## 完了報告

- 「完了」「修正済み」「テスト通過」と報告する場合は、そのターンで実行した検証コマンドと結果を含める。
- 実行できなかった検証がある場合は、理由を明記する。
