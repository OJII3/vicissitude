# store/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  db --> schema
  event_buffer["event-buffer"] --> db
  event_buffer["event-buffer"] --> queries
  mc_bridge["mc-bridge"] --> db
  mc_bridge["mc-bridge"] --> schema
  mc_status_provider["mc-status-provider"] --> db
  mc_status_provider["mc-status-provider"] --> mc_bridge["mc-bridge"]
  minecraft_event_buffer["minecraft-event-buffer"]
  queries --> db
  queries --> schema
  schema
```

## ファイル別依存一覧

### db.ts

- モジュール内依存: schema
- 外部依存: bun:sqlite, drizzle-orm, fs, path

### event-buffer.ts

- モジュール内依存: db, queries
- 他モジュール依存: core/

### mc-bridge.ts

- モジュール内依存: db, schema
- 外部依存: drizzle-orm

### mc-status-provider.ts

- モジュール内依存: db, mc-bridge
- 他モジュール依存: core/

### minecraft-event-buffer.ts

- 他モジュール依存: core/
- 外部依存: fs

### queries.ts

- モジュール内依存: db, schema
- 外部依存: drizzle-orm

### schema.ts

- 外部依存: drizzle-orm
