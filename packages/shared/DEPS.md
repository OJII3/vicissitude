# shared/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  config
  constants
  functions --> constants
  functions --> types
  types
```

## ファイル別依存一覧

### config.ts

- 外部依存: .bun, path

### constants.ts

- 依存なし

### functions.ts

- モジュール内依存: constants, types

### types.ts

- 依存なし
