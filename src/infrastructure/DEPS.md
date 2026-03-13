# infrastructure/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  discord_attachment_mapper["discord/attachment-mapper"]
  store_sqlite_buffered_event_store["store/sqlite-buffered-event-store"]
```

## ファイル別依存一覧

### discord/attachment-mapper.ts
- 他モジュール依存: core/
- 外部依存: discord.js

### store/sqlite-buffered-event-store.ts
- 他モジュール依存: application/, core/, store/
