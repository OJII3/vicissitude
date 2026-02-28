# Vicissitude — CLAUDE.md

## プロジェクト概要

Discord bot「ふあ」のプロジェクト。TypeScript + Bun で動作する。

## コマンド

- `nr check` — 型チェック (`tsgo --noEmit`)
- `nr lint` — Lint (`oxlint`)
- `nr fmt` — フォーマット (`oxfmt`)
- `nr fmt:check` — フォーマット確認
- `nr validate` — fmt:check + lint + check を一括実行
- `nr dev` — 開発モード (watch)
- `nr start` — 本番起動

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
├── composition-root.ts  # DI 配線
└── index.ts          # エントリポイント
```

### 依存方向ルール

- **domain** は他のどのレイヤーにも依存しない（純粋 TS のみ）
- **application** は domain のみに依存する
- **infrastructure** は domain に依存する（ポートを実装する）
- **composition-root** が唯一全レイヤーを参照し、DI 配線を行う

### DI 方針

- 手動コンストラクタ注入（Pure DI）を使用
- DI コンテナライブラリは使わない
- `composition-root.ts` が唯一の配線場所

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
