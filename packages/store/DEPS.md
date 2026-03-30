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
  mood_store["mood-store"] --> db
  mood_store["mood-store"] --> schema
  queries --> db
  queries --> schema
  schema
```

## ファイル別依存一覧

### db.ts

- モジュール内依存: schema
- 外部依存: ../../../node_modules/.bun/drizzle-orm@0.45.1/node_modules/drizzle-orm/bun-sqlite/index.js, bun:sqlite, fs, path

### event-buffer.ts

- モジュール内依存: db, queries
- 他モジュール依存: shared

### mc-bridge.ts

- モジュール内依存: db, schema
- 外部依存: ../../../node_modules/.bun/drizzle-orm@0.45.1/node_modules/drizzle-orm/index.cjs

### mood-store.ts

- モジュール内依存: db, schema
- 他モジュール依存: shared
- 外部依存: ../../../node_modules/.bun/drizzle-orm@0.45.1/node_modules/drizzle-orm/index.cjs

### queries.ts

- モジュール内依存: db, schema
- 外部依存: ../../../node_modules/.bun/drizzle-orm@0.45.1/node_modules/drizzle-orm/index.cjs

### schema.ts

- 外部依存: ../../../node_modules/.bun/drizzle-orm@0.45.1/node_modules/drizzle-orm/sqlite-core/index.js
