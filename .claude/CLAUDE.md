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
- `nr deploy` — install → build → 起動（ソースコード・依存変更時もこれだけでOK）
- `nr deploy:rebuild` — `nr deploy` のエイリアス（後方互換）
- `nr deploy:rebuild-base` — ベースイメージを再ビルドしてデプロイ（bun バージョンやシステムパッケージ変更時のみ）
- `nr deploy:logs` — 実行中コンテナのログをフォロー
- `nr deploy:stop` — コンテナを停止・削除

## デプロイ

- デプロイ前に `hostname` でホストが `Cipher` であることを確認する。`Cipher` 以外ではデプロイしない。
- 詳細手順は `docs/RUNBOOK.md` §3.3 を参照。
- ソースコード・依存変更後: `nr deploy` で再デプロイ（イメージ再ビルド不要）
- bun バージョンやシステムパッケージ変更後: `nr deploy:rebuild-base`

## エージェント運用ガイド

### タスク別の呼び出しパターン

**新機能追加:**

1. `spec-agent` → 仕様テストを書く（or 確認する）
2. `impl-agent` → spec だけ渡して実装させる
3. `test-agent` → unit テストを書く
4. `verify-agent` → 全テスト通るか確認

**バグ修正:**

1. `spec-agent` → 再現テスト（spec）を書く
2. `impl-agent` → 再現テストだけ渡して修正させる
3. `verify-agent` → 既存 spec が壊れてないか確認

**リファクタ:**

1. `verify-agent` → 既存 spec を確認（これが通れば仕様を守れている）
2. `impl-agent` → spec だけ渡してリファクタさせる（unit テストは渡さない）
3. `verify-agent` → spec が通るか確認

> リファクタ時に unit テストを渡さないのがポイント。渡すと実装詳細に縛られる。

### エージェント間の情報境界

| エージェント | 渡すもの | 渡さないもの |
|---|---|---|
| `spec-agent` | タスク説明・既存 spec | 実装コード |
| `impl-agent` | spec・型定義・SCOPE | unit テスト・他モジュールの実装 |
| `test-agent` | 実装コード・spec | 他モジュール |
| `verify-agent` | spec のパス・実行結果 | 実装の中身 |

## マージ前チェック

- PR をマージする前に `docs/STATUS.md` を最新の状態に更新すること（完了タスク、直近タスク、既知バグの反映）
