# spotify/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  auth
  selector --> types
  spotify_client["spotify-client"] --> auth
  spotify_client["spotify-client"] --> types
  types
```

## ファイル別依存一覧

### auth.ts

- 依存なし

### selector.ts

- モジュール内依存: types

### spotify-client.ts

- モジュール内依存: auth, types

### types.ts

- 外部依存: .bun
