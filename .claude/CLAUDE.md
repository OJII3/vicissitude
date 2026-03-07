# Vicissitude — CLAUDE.md

## プロジェクト概要

Discord bot「ふあ」のプロジェクト。TypeScript + Bun で動作する。

## ドキュメント導線

- `docs/SPEC.md`: 要件定義（ふあ人格、メンション/スレッド応答、MCP ツール、コンテキスト運用）
- `docs/PLAN.md`: マイルストーン、リスクレジスタ、DoD
- `docs/ARCHITECTURE.md`: レイヤー構成、データモデル、主要シーケンス、設定項目
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

## アーキテクチャ: Clean Architecture

### レイヤー構成

```
src/
├── domain/           # ドメイン層 — 純粋 TS、外部依存なし
│   ├── entities/     # 型定義・値オブジェクト
│   ├── ports/        # インターフェース（抽象）
│   └── services/     # 純粋関数のドメインサービス
├── application/      # アプリケーション層 — ユースケース
│   └── use-cases/
├── infrastructure/   # インフラ層 — ポートの具象実装
│   ├── discord/
│   ├── opencode/
│   ├── persistence/
│   ├── context/
│   └── logging/
├── mcp/              # MCP サーバー（独立プロセス、レイヤー外）
├── bootstrap-context.ts    # ブートストラップ共有型
├── bootstrap-helpers.ts    # ブートストラップ共有ヘルパー
├── composition-root.ts     # DI 配線エントリポイント
└── index.ts                # エントリポイント
```

### 依存方向ルール

- **domain** は他のどのレイヤーにも依存しない（純粋 TS のみ）
- **application** は domain のみに依存する
- **infrastructure** は domain に依存する（ポートを実装する）
- **composition-root** が唯一全レイヤーを参照し、DI 配線を行う

### DI 方針

- 手動コンストラクタ注入（Pure DI）を使用
- DI コンテナライブラリは使わない
- `composition-root.ts` が配線のエントリポイント。エージェント配線は `bootstrap-agents.ts` に委譲

### 命名規約

- ポート: `*.port.ts` — インターフェース定義
- ユースケース: `*.use-case.ts` — アプリケーションロジック
- エンティティ: ケバブケース `agent-response.ts`
- インフラ実装: 具象名 `discord-gateway.ts`, `console-logger.ts`

### 新機能追加の手順

1. 必要なら `domain/ports/` にインターフェースを定義
2. `domain/entities/` に型を追加
3. `application/use-cases/` にユースケースを追加
4. `infrastructure/` に具象実装を追加
5. `composition-root.ts` で配線

### MCP サーバー

`src/mcp/` は独立プロセスとして起動されるため、Clean Architecture レイヤーの対象外。
