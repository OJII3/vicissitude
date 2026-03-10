# Vicissitude — CLAUDE.md

## プロジェクト概要

Discord bot「ふあ」のプロジェクト。TypeScript + Bun で動作する。

## ドキュメント導線

- `docs/SPEC.md`: 要件定義（ふあ人格、メンション/スレッド応答、MCP ツール、コンテキスト運用）
- `docs/PLAN.md`: マイルストーン、リスクレジスタ、DoD
- `docs/ARCHITECTURE.md`: モジュール構成、データモデル、主要シーケンス、設定項目
- `docs/RUNBOOK.md`: 常時遵守ルール、実行手順、失敗時対応、変更管理
- `docs/STATUS.md`: 現在の真実、確定方針、既知バグ、直近タスク、再開コンテキスト

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
- 初回・設定変更のみ: `nr deploy` でコンテナを起動する
- ソースコード変更後: `nr deploy:rebuild` でリビルド＆再デプロイする

## アーキテクチャ: 責務別モジュール構成

### ディレクトリ構成

```
src/
├── core/               # 型定義・設定・純粋関数（外部依存なし）
├── agent/              # OpenCode エージェント基盤
│   ├── profiles/       # エージェントプロファイル定義
│   └── mcp-config.ts   # MCP サーバー設定
├── gateway/            # Discord ゲートウェイ + メッセージハンドラ + スケジューラ
├── mcp/                # MCP サーバー（独立プロセス）
│   ├── core-server.ts  # 統合エントリポイント
│   ├── code-exec-server.ts
│   ├── minecraft/      # Minecraft MCP + ブリッジ
│   │   └── mc-bridge-server.ts
│   └── tools/          # ツール定義（mc-bridge-discord/minecraft/shared）
├── store/              # SQLite 統一永続化（Drizzle ORM）
├── observability/      # ログ + メトリクス
├── opencode/           # OpenCode SDK 抽象化（Port/Adapter）
├── fenghuang/          # fenghuang LTM アダプタ
├── ollama/             # Ollama 埋め込みアダプタ
├── bootstrap.ts        # DI 配線エントリポイント
└── index.ts            # エントリポイント
```

### DI 方針

- 手動コンストラクタ注入（Pure DI）を使用
- DI コンテナライブラリは使わない
- `bootstrap.ts` が唯一の配線ファイル

### 命名規約

- 型・インターフェース: `core/types.ts` に集約
- 設定: `core/config.ts` に集約
- 純粋関数: `core/functions.ts` に集約
- モジュール実装: ケバブケース（例: `fenghuang-chat-adapter.ts`, `discord.ts`）
- MCP ツール: `mcp/tools/` に `registerXxxTools()` 関数として定義

### 新機能追加の手順

1. 必要なら `core/types.ts` にインターフェースや型を定義
2. 適切なモジュール（agent/, gateway/, fenghuang/ 等）に実装を追加
3. MCP ツールが必要なら `mcp/tools/` にツール定義を追加し、`core-server.ts` で登録
4. `bootstrap.ts` で配線

### マージ前チェック

- PR をマージする前に `docs/STATUS.md` を最新の状態に更新すること（完了タスク、直近タスク、既知バグの反映）

### DEPS.md（依存関係グラフ）

- `docs/DEPS.md` および `src/*/DEPS.md` は commit 時に pre-commit フックで自動生成される（手動実行不要）

### MCP サーバー

`src/mcp/` は独立プロセスとして起動されるため、通常のモジュール構成の対象外。4 プロセス構成: core（統合）、code-exec、minecraft、mc-bridge（Minecraft ブリッジ）。
