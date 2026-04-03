# infrastructure/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  discord_attachment_mapper["discord/attachment-mapper"]
  discord_url_rewriter["discord/url-rewriter"]
  store_sqlite_buffered_event_store["store/sqlite-buffered-event-store"]
```

## ファイル別依存一覧

### discord/attachment-mapper.ts

- 他モジュール依存: shared
- 外部依存: ../../../node_modules/.bun/discord.js@14.25.1/node_modules/discord.js/src/index.js

### discord/url-rewriter.ts

- 依存なし

### store/sqlite-buffered-event-store.ts

- 他モジュール依存: application, shared, store
