# store/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  db --> schema
  event-buffer --> db
  event-buffer --> queries
  mc-bridge --> db
  mc-bridge --> schema
  mc-status-provider --> db
  mc-status-provider --> mc-bridge
  mc-sub-event-buffer
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

### mc-sub-event-buffer.ts

- 他モジュール依存: core/

### queries.ts

- モジュール内依存: db, schema
- 外部依存: drizzle-orm

### schema.ts

- 外部依存: drizzle-orm
