# Vicissitude

## プロジェクト概要

Discord bot「ふあ(hua)」のプロジェクト。Bun, TypeScript, OpenCode で動作する。

## ドキュメント導線

再開時は以下の順で読むことでプロジェクト全体を把握できる:

1. `docs/ARCHITECTURE.md`: モジュール構成、DI 方針、データモデル、主要シーケンス、設計判断（**構成の正本**）
2. `docs/SPEC.md`: 要件定義（ふあ人格、メンション/スレッド応答、MCP ツール、コンテキスト運用）
3. `docs/STATUS.md`: 既知バグ、直近タスク、ブロッカー
4. `docs/PLAN.md`: 未着手/進行中の計画、DoD
5. `docs/RUNBOOK.md`: 常時遵守ルール、実行手順（デプロイ詳細含む）、失敗時対応、変更管理
6. `docs/CHANGELOG.md`: 完了済みマイルストーン、タスク、設計判断の記録

依存関係グラフ（概要把握に有用）:

- `docs/DEPS.md`: プロジェクト全体の依存関係グラフ
- `src/*/DEPS.md`: 各モジュール内の依存関係グラフ
- ※ いずれも commit 時に lefthook の pre-commit フックで自動生成（手動実行不要）

## コマンド

- `nr check` — 型チェック (`tsgo --noEmit`)
- `nr lint` — Lint (`oxlint`)
- `nr lint:fix` — Lint 自動修正 (`oxlint --fix`)
- `nr fmt` — フォーマット (`oxfmt`)
- `nr fmt:check` — フォーマット確認
- `nr validate` — fmt:check + lint + check を一括実行
- `nr dev` — 開発モード (watch)
- `nr start` — 本番起動
- `nr deploy` — Podman Compose でコンテナをデプロイ
- `nr deploy:rebuild` — コンテナを停止・リビルド・再デプロイ（ソースコード変更時）
- `nr deploy:logs` — 実行中コンテナのログをフォロー
- `nr deploy:stop` — コンテナを停止・削除

## デプロイ

- デプロイ前に `hostname` でホストが `Cipher` であることを確認する。`Cipher` 以外ではデプロイしない。
- 詳細手順は `docs/RUNBOOK.md` §3.3 を参照。
- 初回・設定変更のみ: `nr deploy` でコンテナを起動する
- ソースコード変更後: `nr deploy:rebuild` でリビルド＆再デプロイする

## マージ前チェック

- PR をマージする前に `docs/STATUS.md` を最新の状態に更新すること（完了タスク、直近タスク、既知バグの反映）
