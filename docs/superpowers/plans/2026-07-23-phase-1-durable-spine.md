# Phase 1 Durable Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discordの明示mentionを重複なく永続化し、pi agentで短い日本語応答を生成し、監査可能で冪等なDiscord replyとして実行できる最初の縦断スライスを構築する。

**Architecture:** 単一TypeScript package内をmodule境界で分け、実行時は `discord-gateway`、`cognition-worker`、`admin-cli` のentrypointを持つ。PostgreSQLをevent、job、decision、model call、effect、auditの正本とし、GatewayはDiscord DTOと外部作用だけ、workerはpi agentを使う判断だけを担当する。

**Tech Stack:** Node.js 24、TypeScript 5.9.3、pnpm 11.16.0、PostgreSQL 17、postgres.js 3.4.9、discord.js 14.27.0、`@earendil-works/pi-ai` 0.81.1、`@earendil-works/pi-agent-core` 0.81.1、Zod 4.4.3、Pino 10.3.1、Vitest 4.1.10、Oxlint、Oxfmt、Nix flakes

---

## Source Specifications

- `docs/superpowers/specs/2026-07-23-ai-character-platform-architecture-design.md`
- AIキャラクター基盤 要求ベースライン v0.1のうち、Phase 1に割り当てた要求
- 主対象: FR-101、FR-102、FR-303、AR-*、MR-101からMR-106、OR-101からOR-105、CR-*、AC-10、AC-11

## Phase 1 Scope

Phase 1で提供するもの:

- 再現可能なNode.js/Nix開発環境
- versionとchecksumを持つ明示migration
- canonical Discord message eventと30日retention metadata
- channel capabilityと `mention_only` 規則
- event deduplicationとtransactional job enqueue
- lease付きPostgreSQL job queue
- production CharacterDefinitionのimport・activate
- 用途別model routeとpi agent adapter
- decision run、model call、effect ledger、audit
- Discord replyのnonceによる冪等化
- system stop、drain、resume
- migration、channel、character、effect用admin CLI
- health、readiness、graceful shutdown

Phase 1で提供しないもの:

- 暗黙的な宛先推定
- 会話cluster、typing待機、short batch
- 長期memory、relationship、interest、emotion
- 自発発言、reaction、thread、file、link
- shell worker、Web調査、artifact
- feedback、adaptation、shadow、週次report
- 本番用の具体的人格。別仕様で承認されたCharacterDefinitionだけ登録可能にする

## Repository Policy

この計画の実行中は、ユーザーが明示的にcommitを依頼しない限りcommitしない。各Task末尾では `git diff --check` と対象testを実行し、変更checkpointを提示する。

## File Map

```text
.
├── .env.example
├── .gitignore
├── .oxfmtrc.json
├── .github/workflows/ci.yml
├── config/model-routes.example.json
├── migrations/0001_durable_spine.sql
├── scripts/test-with-postgres.mjs
├── src
│   ├── apps
│   │   ├── admin-cli.ts
│   │   ├── cognition-worker.ts
│   │   └── discord-gateway.ts
│   ├── adapters
│   │   ├── discord
│   │   │   ├── channel-command.ts
│   │   │   ├── discord-client.ts
│   │   │   ├── discord-effect-executor.ts
│   │   │   └── message-snapshot.ts
│   │   ├── pi
│   │   │   ├── pi-agent-runtime.ts
│   │   │   └── pi-models.ts
│   │   └── postgres
│   │       ├── channel-capability-repository.ts
│   │       ├── character-repository.ts
│   │       ├── client.ts
│   │       ├── decision-effect-store.ts
│   │       ├── effect-queue.ts
│   │       ├── ingestion-store.ts
│   │       ├── job-queue.ts
│   │       ├── migrations.ts
│   │       └── system-control-repository.ts
│   ├── config
│   │   ├── model-routes.ts
│   │   └── runtime-config.ts
│   ├── modules
│   │   ├── admin/admin-command.ts
│   │   ├── channels/channel-capability.ts
│   │   ├── characters/character-definition.ts
│   │   ├── effects/effect.ts
│   │   ├── effects/run-effect-worker.ts
│   │   ├── events/canonical-event.ts
│   │   ├── events/ingest-message.ts
│   │   ├── jobs/job-queue.ts
│   │   ├── jobs/run-worker.ts
│   │   ├── mentions/process-mention.ts
│   │   ├── models/agent-runtime.ts
│   │   └── system/system-control.ts
│   ├── observability/logger.ts
│   └── shared
│       ├── clock.ts
│       ├── health-server.ts
│       ├── ids.ts
│       └── process-lifecycle.ts
├── spec
│   ├── adapters
│   ├── e2e
│   └── modules
├── package.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

## Task 1: Bootstrap the Node.js and Nix Project

**Files:**

- Modify: `flake.nix`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.oxfmtrc.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/shared/clock.test.ts`
- Create: `src/shared/clock.ts`
- Create: `src/shared/ids.ts`

- [ ] **Step 1: Replace the empty flake with a pinned development shell**

```nix
{
  description = "Vicissitude AI character platform";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.postgresql_17
          ];
        };
        formatter = pkgs.nixfmt-rfc-style;
      };
    };
}
```

- [ ] **Step 2: Create the exact package manifest**

```json
{
  "name": "vicissitude",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24 <25"
  },
  "packageManager": "pnpm@11.16.0",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check": "tsc --noEmit -p tsconfig.json",
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "lint": "oxlint --type-aware --deny-warnings .",
    "test:unit": "vitest run src",
    "test:spec": "node scripts/test-with-postgres.mjs",
    "test": "pnpm test:unit && pnpm test:spec",
    "validate": "pnpm format:check && pnpm lint && pnpm check && pnpm test",
    "start:gateway": "node dist/apps/discord-gateway.js",
    "start:worker": "node dist/apps/cognition-worker.js",
    "admin": "node dist/apps/admin-cli.js"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.81.1",
    "@earendil-works/pi-ai": "0.81.1",
    "discord.js": "14.27.0",
    "pino": "10.3.1",
    "postgres": "3.4.9",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "24.12.0",
    "oxfmt": "0.60.0",
    "oxlint": "1.75.0",
    "oxlint-tsgolint": "7.0.2001",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 3: Add compiler, test, formatter, ignore, and environment files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "spec/**/*.ts", "vitest.config.ts"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "spec/**/*.spec.ts"],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
```

`.oxfmtrc.json`:

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false
}
```

`.gitignore`:

```gitignore
.env
dist/
node_modules/
result
coverage/
*.log
.tmp/
```

`.env.example`:

```dotenv
DATABASE_URL=postgresql://vicissitude:vicissitude@127.0.0.1:5432/vicissitude
DISCORD_TOKEN=
VICISSITUDE_CHARACTER_ID=primary
VICISSITUDE_MODEL_ROUTES_PATH=config/model-routes.json
VICISSITUDE_MIGRATIONS_DIR=migrations
LOG_LEVEL=info
```

- [ ] **Step 4: Install dependencies and create the lockfile**

Run: `nix develop -c pnpm install`

Expected: `pnpm-lock.yaml` is created and all exact dependencies install without peer dependency errors.

- [ ] **Step 5: Write the first failing unit test**

`src/shared/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "./clock.js";
import { newId } from "./ids.js";

describe("shared runtime primitives", () => {
  it("provides injectable time", () => {
    const instant = new Date("2026-07-23T00:00:00.000Z");
    expect(new FixedClock(instant).now()).toEqual(instant);
    expect(SystemClock.now()).toBeInstanceOf(Date);
  });

  it("creates UUID identifiers", () => {
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
```

- [ ] **Step 6: Run the unit test and verify it fails**

Run: `nix develop -c pnpm test:unit`

Expected: FAIL because `clock.ts` and `ids.ts` do not exist.

- [ ] **Step 7: Implement the minimal runtime primitives**

`src/shared/clock.ts`:

```ts
export interface Clock {
  now(): Date;
}

export const SystemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant);
  }
}
```

`src/shared/ids.ts`:

```ts
import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}
```

- [ ] **Step 8: Verify the scaffold**

Run: `nix develop -c pnpm format && nix develop -c pnpm test:unit && nix develop -c pnpm check && nix flake check`

Expected: unit tests PASS, TypeScript reports no errors, and the flake evaluates successfully.

- [ ] **Step 9: Record the checkpoint**

Run: `git diff --check && git status --short`

Expected: only the intended scaffold and generated lockfile are listed; do not commit unless explicitly requested.

## Task 2: Add the PostgreSQL Test Harness and Versioned Migrations

**Files:**

- Create: `scripts/test-with-postgres.mjs`
- Create: `migrations/0001_durable_spine.sql`
- Create: `src/adapters/postgres/client.ts`
- Create: `src/adapters/postgres/migrations.ts`
- Create: `spec/adapters/postgres/migrations.spec.ts`

- [ ] **Step 1: Add a real PostgreSQL test harness**

Create `scripts/test-with-postgres.mjs`:

```js
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve PostgreSQL port");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForPostgres(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await run("pg_isready", ["-h", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PostgreSQL did not become ready");
}

const root = await mkdtemp(join(tmpdir(), "vicissitude-postgres-"));
const data = join(root, "data");
const socket = join(root, "socket");
const port = await reservePort();
let postgresProcess;

try {
  await run("mkdir", [socket]);
  await run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  postgresProcess = spawn("postgres", ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-k", socket], {
    stdio: "inherit",
  });
  await waitForPostgres(port);
  await run("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "vicissitude_test"]);
  await run("pnpm", ["exec", "vitest", "run", "spec"], {
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/vicissitude_test`,
      VICISSITUDE_MIGRATIONS_DIR: "migrations",
    },
  });
} finally {
  if (postgresProcess) {
    postgresProcess.kill("SIGTERM");
    await new Promise((resolve) => postgresProcess.once("exit", resolve));
  }
  await rm(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Write the failing migration specification**

`spec/adapters/postgres/migrations.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { migrationStatus, runMigrations } from "../../../src/adapters/postgres/migrations.js";

let sql: Sql;

function assertMigrationContextRequired(enabled: boolean): void {
  if (enabled) {
    // @ts-expect-error migration application requires an explicit audit context
    void runMigrations(sql, "migrations");
  }
}

assertMigrationContextRequired(false);

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await sql`drop schema public cascade`;
  await sql`create schema public`;
});

afterAll(async () => {
  await sql.end();
});

describe("versioned migrations", () => {
  it("applies each migration once and records its checksum", async () => {
    const first = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    const second = await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    expect(first).toMatchObject({ appliedVersions: ["0001"] });
    expect(second).toMatchObject({ appliedVersions: [] });
    expect(first.appliedAt).toBeInstanceOf(Date);

    const status = await migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!);
    expect(status).toEqual([expect.objectContaining({ version: "0001", name: "durable_spine", state: "applied" })]);
    expect(status[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an applied migration with an empty checksum", async () => {
    const rows = await sql<{ checksum: string }[]>`
      select checksum from schema_migrations where version = '0001'
    `;
    const checksum = rows[0]?.checksum;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/u);

    await sql`update schema_migrations set checksum = '' where version = '0001'`;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration checksum mismatch: 0001",
      );
    } finally {
      await sql`update schema_migrations set checksum = ${checksum!} where version = '0001'`;
    }
  });

  it("serializes concurrent migration runs and records one history row", async () => {
    const first = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const second = createPostgresClient(process.env.TEST_DATABASE_URL!);
    try {
      await sql`drop schema public cascade`;
      await sql`create schema public`;
      const [firstResult, secondResult] = (await Promise.all([
        runMigrations(first, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "first",
          backupConfirmedAt: new Date(),
        }),
        runMigrations(second, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "second",
          backupConfirmedAt: new Date(),
        }),
      ])) as [{ appliedVersions: string[] }, { appliedVersions: string[] }];
      expect([firstResult.appliedVersions, secondResult.appliedVersions].sort((a, b) => a.length - b.length)).toEqual([
        [],
        ["0001"],
      ]);
      const rows = await sql`select version from schema_migrations where version = '0001'`;
      expect(rows).toHaveLength(1);
      const audits = await sql`select id from audit_entries where category = 'migration.applied'`;
      expect(audits).toHaveLength(2);
    } finally {
      await first.end();
      await second.end();
      await sql`drop schema public cascade`;
      await sql`create schema public`;
    }
  });

  it("rejects database-only migration history", async () => {
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`
      insert into schema_migrations (version, name, checksum, applied_at)
      values ('9999', 'missing_local', 'checksum', now())
    `;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration history contains unknown version: 9999",
      );
    } finally {
      await sql`delete from schema_migrations where version = '9999'`;
    }
  });

  it("rejects a migration history name mismatch", async () => {
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    const rows = await sql<{ checksum: string }[]>`
      select checksum from schema_migrations where version = '0001'
    `;
    await sql`update schema_migrations set name = 'wrong_name' where version = '0001'`;
    try {
      await expect(migrationStatus(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!)).rejects.toThrow(
        "Migration name mismatch: 0001",
      );
    } finally {
      await sql`update schema_migrations set name = 'durable_spine', checksum = ${rows[0]!.checksum} where version = '0001'`;
    }
  });

  it("rejects duplicate migration versions in a temporary directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vicissitude-migrations-"));
    try {
      await sql`drop schema public cascade`;
      await sql`create schema public`;
      await writeFile(join(directory, "0001_first.sql"), "select 1;");
      await writeFile(join(directory, "0001_second.sql"), "select 2;");
      await expect(migrationStatus(sql, directory)).rejects.toThrow("Duplicate migration version: 0001");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await sql`drop schema public cascade`;
      await sql`create schema public`;
    }
  });

  it("returns applied versions and records an admin audit for an explicit context", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const backupConfirmedAt = new Date();
    const result = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "admin@example.com",
      backupConfirmedAt,
    }))!;
    expect(result.appliedVersions).toEqual(["0001"]);
    expect(result.appliedAt).toBeInstanceOf(Date);
    const rows = await sql<{ summary: { actor: string; backupConfirmedAt: string; appliedVersions: string[] } }[]>`
      select summary from audit_entries where category = 'migration.applied'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toMatchObject({ actor: "admin@example.com", appliedVersions: ["0001"] });
    expect(new Date(rows[0]!.summary.backupConfirmedAt).getTime()).toBe(backupConfirmedAt.getTime());
  });

  it("audits an explicit no-op with no applied versions", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const context = { actor: "admin@example.com", backupConfirmedAt: new Date() };
    const first = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context))!;
    const second = (await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context))!;
    expect(first.appliedVersions).toEqual(["0001"]);
    expect(second.appliedVersions).toEqual([]);
    const rows = await sql<{ summary: { appliedVersions: string[] } }[]>`
      select summary from audit_entries where category = 'migration.applied' order by created_at
    `;
    expect(rows.at(-1)?.summary.appliedVersions).toEqual([]);
  });

  it.each([
    ["blank actor", { actor: " ", backupConfirmedAt: new Date() }],
    ["invalid date", { actor: "admin", backupConfirmedAt: new Date(Number.NaN) }],
  ])("rejects context with %s before creating migration tables", async (_label, context) => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await expect(runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, context)).rejects.toThrow();
    const tables = await sql<{ exists: boolean }[]>`
      select to_regclass('public.schema_migrations') is not null as exists
    `;
    expect(tables[0]?.exists).toBe(false);
  });

  it("revalidates backup age after waiting for the migration lock", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const locker = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lock = locker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(84623817)`;
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    });
    try {
      await acquired;
      await expect(
        runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
          actor: "admin",
          backupConfirmedAt: new Date(Date.now() - 24 * 60 * 60 * 1000 + 500),
        }),
      ).rejects.toThrow(/backup confirmation is too old/u);
    } finally {
      await lock;
      await locker.end();
    }
  });

  it("records applied_at after an advisory lock is released", async () => {
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    const locker = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const lock = locker.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(84623817)`;
      lockAcquired();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await acquired;
    const applying = runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-lock-release",
      backupConfirmedAt: new Date(),
    });
    await lock;
    const releasedAt = new Date();
    await applying;
    const rows = await sql<{ applied_at: Date }[]>`select applied_at from schema_migrations where version = '0001'`;
    await locker.end();
    expect(rows[0]!.applied_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
  });
});
```

- [ ] **Step 3: Run the specification and verify it fails**

Run: `nix develop -c pnpm test:spec`

Expected: FAIL because the PostgreSQL client and migration runner do not exist.

- [ ] **Step 4: Create the initial SQL migration**

Create `migrations/0001_durable_spine.sql` with the following complete schema:

```sql
CREATE TABLE system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'running' CHECK (mode IN ('running', 'draining', 'stopped')),
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  reason text NOT NULL
);

INSERT INTO system_state (singleton, mode, updated_at, updated_by, reason)
VALUES (true, 'running', now(), 'migration', 'initial state');

CREATE TABLE channel_capabilities (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  observe_events boolean NOT NULL DEFAULT false,
  respond_to_mentions boolean NOT NULL DEFAULT false,
  spontaneous_join boolean NOT NULL DEFAULT false,
  spontaneous_topic boolean NOT NULL DEFAULT false,
  add_reactions boolean NOT NULL DEFAULT false,
  create_threads boolean NOT NULL DEFAULT false,
  share_files boolean NOT NULL DEFAULT false,
  share_external_links boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE character_definitions (
  character_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'production', 'retired')),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  created_by text NOT NULL,
  PRIMARY KEY (character_id, version)
);

CREATE UNIQUE INDEX one_production_character_version
ON character_definitions (character_id)
WHERE status = 'production';

CREATE TABLE events (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL,
  source text NOT NULL CHECK (source = 'discord'),
  external_event_id text NOT NULL,
  external_version text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message.created', 'message.updated', 'message.deleted')),
  visibility text NOT NULL CHECK (visibility IN ('observed', 'mention_only')),
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  thread_id text,
  actor_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'bot')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  content jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (source, external_event_id, external_version)
);

CREATE INDEX events_expires_at_idx ON events (expires_at);
CREATE INDEX events_scope_time_idx ON events (guild_id, channel_id, occurred_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('mention_response')),
  event_id uuid NOT NULL REFERENCES events(id),
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL,
  leased_until timestamptz,
  lease_owner text,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (kind, event_id)
);

CREATE INDEX jobs_claim_idx ON jobs (state, available_at, priority DESC, created_at);

CREATE TABLE decision_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id),
  event_id uuid NOT NULL REFERENCES events(id),
  character_id text NOT NULL,
  character_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  action_kind text CHECK (action_kind IN ('reply')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  model_route_version text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE TABLE model_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES decision_runs(id),
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  route_version text NOT NULL,
  attempt integer NOT NULL,
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'aborted')),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_usd double precision NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL,
  fallback_from text,
  structured_output_failure boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL
);

CREATE TABLE effects (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES decision_runs(id),
  effect_slot text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discord.reply')),
  state text NOT NULL CHECK (state IN ('planned', 'executing', 'succeeded', 'failed', 'unknown')),
  guild_id text NOT NULL,
  capability_channel_id text NOT NULL,
  target_channel_id text NOT NULL,
  target_message_id text NOT NULL,
  payload jsonb NOT NULL,
  capability_decision jsonb NOT NULL,
  external_resource_id text,
  executor_id text,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (run_id, effect_slot)
);

CREATE INDEX effects_claim_idx ON effects (state, created_at);

CREATE TABLE audit_entries (
  id uuid PRIMARY KEY,
  category text NOT NULL,
  event_id uuid REFERENCES events(id),
  job_id uuid REFERENCES jobs(id),
  run_id uuid REFERENCES decision_runs(id),
  effect_id uuid REFERENCES effects(id),
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX audit_entries_run_idx ON audit_entries (run_id, created_at);
CREATE INDEX audit_entries_effect_idx ON audit_entries (effect_id, created_at);
```

- [ ] **Step 5: Implement the PostgreSQL client and migration runner**

`src/adapters/postgres/client.ts`:

```ts
import postgres, { type Sql } from "postgres";

export function createPostgresClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => undefined,
  });
}
```

`src/adapters/postgres/migrations.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql, TransactionSql } from "postgres";

export interface MigrationStatus {
  version: string;
  name: string;
  checksum: string;
  state: "applied" | "pending";
}

export interface MigrationApplyContext {
  actor: string;
  backupConfirmedAt: Date;
}

export interface MigrationRunResult {
  appliedVersions: string[];
  appliedAt: Date;
}

interface MigrationFile extends MigrationStatus {
  sql: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort();
  const migrations = await Promise.all(
    names.map(async (fileName) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/u.exec(fileName);
      if (!match) throw new Error(`Invalid migration file name: ${fileName}`);
      const sql = await readFile(join(directory, fileName), "utf8");
      return {
        version: match[1]!,
        name: match[2]!,
        checksum: createHash("sha256").update(sql).digest("hex"),
        state: "pending" as const,
        sql,
      };
    }),
  );
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

async function ensureMigrationTable(sql: Sql | TransactionSql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null
    )
  `;
}

function validateHistory(files: MigrationFile[], rows: AppliedMigration[]): Map<string, AppliedMigration> {
  const localVersions = new Set(files.map((file) => file.version));
  for (const row of rows) {
    if (!localVersions.has(row.version)) throw new Error(`Migration history contains unknown version: ${row.version}`);
  }
  return new Map(rows.map((row) => [row.version, row]));
}

function validateMigration(file: MigrationFile, existing: AppliedMigration): void {
  if (existing.name !== file.name) throw new Error(`Migration name mismatch: ${file.version}`);
  if (existing.checksum !== file.checksum) throw new Error(`Migration checksum mismatch: ${file.version}`);
}

const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

function validateApplyContext(context: MigrationApplyContext): void {
  if (!context.actor.trim()) throw new Error("Migration actor must not be blank");
  if (!Number.isFinite(context.backupConfirmedAt.getTime())) throw new Error("Migration backup date is invalid");
}

export async function migrationStatus(sql: Sql, directory: string): Promise<MigrationStatus[]> {
  const files = await loadMigrations(directory);
  const relation = await sql<{ exists: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as exists
  `;
  if (!relation[0]?.exists)
    return files.map(({ version, name, checksum }) => ({ version, name, checksum, state: "pending" }));
  const rows = await sql<AppliedMigration[]>`
    select version, name, checksum from schema_migrations order by version
  `;
  const applied = validateHistory(files, rows);
  return files.map(({ version, name, checksum }) => {
    const existing = applied.get(version);
    if (existing !== undefined) validateMigration({ version, name, checksum, state: "pending", sql: "" }, existing);
    return { version, name, checksum, state: existing !== undefined ? "applied" : "pending" };
  });
}

export async function runMigrations(
  sql: Sql,
  directory: string,
  context: MigrationApplyContext,
): Promise<MigrationRunResult> {
  validateApplyContext(context);
  const files = await loadMigrations(directory);
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(84623817)`;
    const lockTimeRows = await transaction<{ now: Date }[]>`select clock_timestamp() as now`;
    const lockTime = lockTimeRows[0]!.now;
    const backupAgeMs = lockTime.getTime() - context.backupConfirmedAt.getTime();
    if (backupAgeMs < 0 || backupAgeMs > MAX_BACKUP_AGE_MS) throw new Error("Migration backup confirmation is too old");
    await ensureMigrationTable(transaction);
    const rows = await transaction<AppliedMigration[]>`
      select version, name, checksum from schema_migrations order by version
    `;
    const applied = validateHistory(files, rows);
    const appliedVersions: string[] = [];
    for (const file of files) {
      const existing = applied.get(file.version);
      if (existing !== undefined) {
        validateMigration(file, existing);
        continue;
      }
      await transaction.unsafe(file.sql);
      await transaction`
        insert into schema_migrations (version, name, checksum, applied_at)
        values (${file.version}, ${file.name}, ${file.checksum}, clock_timestamp())
      `;
      appliedVersions.push(file.version);
    }
    const appliedAtRows = await transaction<{ now: Date }[]>`select clock_timestamp() as now`;
    const appliedAt = appliedAtRows[0]!.now;
    await transaction`
      insert into audit_entries (id, category, summary, created_at)
      values (
        ${randomUUID()},
        'migration.applied',
        ${transaction.json({ actor: context.actor, backupConfirmedAt: context.backupConfirmedAt, appliedVersions })},
        ${appliedAt}
      )
    `;
    return { appliedVersions, appliedAt };
  });
}
```

- [ ] **Step 6: Run the migration specification**

Run: `nix develop -c pnpm test:spec`

Expected: PASS; a second migration run makes no changes and the checksum is stable.

- [ ] **Step 7: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check && git status --short`

Expected: migration code, SQL, and the PostgreSQL harness are the only new Task 2 files.

## Task 3: Define Canonical Events and Ingestion Policy

**Files:**

- Create: `src/modules/channels/channel-capability.ts`
- Create: `src/modules/system/system-control.ts`
- Create: `src/modules/events/canonical-event.ts`
- Create: `src/modules/events/ingest-message.ts`
- Create: `spec/modules/events/ingest-message.spec.ts`

- [ ] **Step 1: Write the failing black-box ingestion specification**

`spec/modules/events/ingest-message.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../../../src/shared/clock.js";
import { ingestDiscordMessage, type IngestionStore } from "../../../src/modules/events/ingest-message.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../../src/modules/channels/channel-capability.js";

const clock = new FixedClock(new Date("2026-07-23T00:00:00.000Z"));
const message = {
  externalEventId: "111",
  externalVersion: "0",
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: null,
  actorId: "user-1",
  actorKind: "human" as const,
  occurredAt: new Date("2026-07-22T23:59:59.000Z"),
  content: "こんにちは",
  mentionedBot: false,
  mentionIds: [] as string[],
  replyToMessageId: null,
  attachments: [] as Array<{ id: string; name: string; contentType: string | null; url: string; size: number }>,
};

function capabilities(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return { ...denyAllCapabilities("guild-1", "channel-1"), ...overrides };
}

describe("ingestDiscordMessage", () => {
  it("does not persist content from a channel with no capability", async () => {
    const store: IngestionStore = { saveEventAndMaybeEnqueue: vi.fn() };
    const result = await ingestDiscordMessage(message, capabilities(), "running", store, clock);
    expect(result).toEqual({ kind: "ignored", reason: "channel_not_allowed" });
    expect(store.saveEventAndMaybeEnqueue).not.toHaveBeenCalled();
  });

  it("stores a mention-only event and queues a response", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-1", duplicate: false });
    const result = await ingestDiscordMessage(
      { ...message, mentionedBot: true, mentionIds: ["bot-1"] },
      capabilities({ respondToMentions: true }),
      "running",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-1", duplicate: false, jobQueued: true });
    expect(saveEventAndMaybeEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "mention_only", expiresAt: new Date("2026-08-22T00:00:00.000Z") }),
      expect.objectContaining({ kind: "mention_response", priority: 100 }),
    );
  });

  it("stores observed non-mentions without queuing a response", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-2", duplicate: false });
    const result = await ingestDiscordMessage(
      message,
      capabilities({ observeEvents: true }),
      "running",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-2", duplicate: false, jobQueued: false });
    expect(saveEventAndMaybeEnqueue).toHaveBeenCalledWith(expect.objectContaining({ visibility: "observed" }), null);
  });

  it("persists a mention while stopped but does not queue work", async () => {
    const saveEventAndMaybeEnqueue = vi.fn().mockResolvedValue({ eventId: "event-3", duplicate: false });
    const result = await ingestDiscordMessage(
      { ...message, mentionedBot: true, mentionIds: ["bot-1"] },
      capabilities({ observeEvents: true, respondToMentions: true }),
      "stopped",
      { saveEventAndMaybeEnqueue },
      clock,
    );
    expect(result).toEqual({ kind: "accepted", eventId: "event-3", duplicate: false, jobQueued: false });
  });
});
```

- [ ] **Step 2: Run the specification and verify it fails**

Run: `nix develop -c pnpm exec vitest run spec/modules/events/ingest-message.spec.ts`

Expected: FAIL because the channel, system, event, and ingestion contracts do not exist.

- [ ] **Step 3: Implement channel and system contracts**

`src/modules/channels/channel-capability.ts`:

```ts
export interface ChannelCapabilities {
  guildId: string;
  channelId: string;
  observeEvents: boolean;
  respondToMentions: boolean;
  spontaneousJoin: boolean;
  spontaneousTopic: boolean;
  addReactions: boolean;
  createThreads: boolean;
  shareFiles: boolean;
  shareExternalLinks: boolean;
}

export function denyAllCapabilities(guildId: string, channelId: string): ChannelCapabilities {
  return {
    guildId,
    channelId,
    observeEvents: false,
    respondToMentions: false,
    spontaneousJoin: false,
    spontaneousTopic: false,
    addReactions: false,
    createThreads: false,
    shareFiles: false,
    shareExternalLinks: false,
  };
}
```

`src/modules/system/system-control.ts`:

```ts
export type SystemMode = "running" | "draining" | "stopped";

export interface SystemState {
  mode: SystemMode;
  updatedAt: Date;
  updatedBy: string;
  reason: string;
}
```

- [ ] **Step 4: Implement canonical event types**

`src/modules/events/canonical-event.ts`:

```ts
export interface AttachmentMetadata {
  id: string;
  name: string;
  contentType: string | null;
  url: string;
  size: number;
}

export interface DiscordMessageInput {
  externalEventId: string;
  externalVersion: string;
  guildId: string;
  channelId: string;
  threadId: string | null;
  actorId: string;
  actorKind: "human" | "bot";
  occurredAt: Date;
  content: string;
  mentionedBot: boolean;
  mentionIds: string[];
  replyToMessageId: string | null;
  attachments: AttachmentMetadata[];
}

export interface CanonicalMessageEvent {
  id: string;
  schemaVersion: 1;
  source: "discord";
  externalEventId: string;
  externalVersion: string;
  kind: "message.created";
  visibility: "observed" | "mention_only";
  guildId: string;
  channelId: string;
  threadId: string | null;
  actorId: string;
  actorKind: "human" | "bot";
  occurredAt: Date;
  receivedAt: Date;
  content: {
    text: string;
    mentionedBot: boolean;
    mentionIds: string[];
    replyToMessageId: string | null;
    attachments: AttachmentMetadata[];
  };
  expiresAt: Date;
}
```

- [ ] **Step 5: Implement the ingestion use case**

`src/modules/events/ingest-message.ts`:

```ts
import type { Clock } from "../../shared/clock.js";
import { newId } from "../../shared/ids.js";
import type { ChannelCapabilities } from "../channels/channel-capability.js";
import type { SystemMode } from "../system/system-control.js";
import type { CanonicalMessageEvent, DiscordMessageInput } from "./canonical-event.js";

const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MentionResponseJobInput {
  id: string;
  kind: "mention_response";
  eventId: string;
  priority: 100;
  availableAt: Date;
  maxAttempts: 3;
}

export interface IngestionStore {
  saveEventAndMaybeEnqueue(
    event: CanonicalMessageEvent,
    job: MentionResponseJobInput | null,
  ): Promise<{ eventId: string; duplicate: boolean }>;
}

export type IngestMessageResult =
  | { kind: "ignored"; reason: "channel_not_allowed" }
  | { kind: "accepted"; eventId: string; duplicate: boolean; jobQueued: boolean };

export async function ingestDiscordMessage(
  input: DiscordMessageInput,
  capability: ChannelCapabilities,
  systemMode: SystemMode,
  store: IngestionStore,
  clock: Clock,
): Promise<IngestMessageResult> {
  const mentionAllowed = input.mentionedBot && input.actorKind === "human" && capability.respondToMentions;
  if (!capability.observeEvents && !mentionAllowed) {
    return { kind: "ignored", reason: "channel_not_allowed" };
  }

  const now = clock.now();
  const event: CanonicalMessageEvent = {
    id: newId(),
    schemaVersion: 1,
    source: "discord",
    externalEventId: input.externalEventId,
    externalVersion: input.externalVersion,
    kind: "message.created",
    visibility: capability.observeEvents ? "observed" : "mention_only",
    guildId: input.guildId,
    channelId: input.channelId,
    threadId: input.threadId,
    actorId: input.actorId,
    actorKind: input.actorKind,
    occurredAt: input.occurredAt,
    receivedAt: now,
    content: {
      text: input.content,
      mentionedBot: input.mentionedBot,
      mentionIds: [...input.mentionIds],
      replyToMessageId: input.replyToMessageId,
      attachments: input.attachments.map((attachment) => ({ ...attachment })),
    },
    expiresAt: new Date(now.getTime() + RAW_EVENT_RETENTION_MS),
  };

  const shouldQueue = mentionAllowed && systemMode === "running";
  const job: MentionResponseJobInput | null = shouldQueue
    ? { id: newId(), kind: "mention_response", eventId: event.id, priority: 100, availableAt: now, maxAttempts: 3 }
    : null;
  const saved = await store.saveEventAndMaybeEnqueue(event, job);
  return { kind: "accepted", eventId: saved.eventId, duplicate: saved.duplicate, jobQueued: shouldQueue && !saved.duplicate };
}
```

- [ ] **Step 6: Run the ingestion specification**

Run: `nix develop -c pnpm exec vitest run spec/modules/events/ingest-message.spec.ts`

Expected: all four ingestion policy tests PASS.

- [ ] **Step 7: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no TypeScript or whitespace errors.

## Task 4: Persist Channel Capabilities and Ingestion Atomically

**Files:**

- Create: `src/adapters/postgres/channel-capability-repository.ts`
- Create: `src/adapters/postgres/ingestion-store.ts`
- Create: `spec/adapters/postgres/ingestion-store.spec.ts`

- [ ] **Step 1: Write the failing PostgreSQL specification**

`spec/adapters/postgres/ingestion-store.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../../src/modules/channels/channel-capability.js";
import type { CanonicalMessageEvent } from "../../../src/modules/events/canonical-event.js";
import type { MentionResponseJobInput } from "../../../src/modules/events/ingest-message.js";
import {
  PostgresChannelCapabilityRepository,
  type ChannelCapabilitiesPatch,
} from "../../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresIngestionStore } from "../../../src/adapters/postgres/ingestion-store.js";

let sql: Sql;

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events, channel_capabilities cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("PostgresChannelCapabilityRepository", () => {
  it("returns deny-all capabilities without writing a missing row", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);

    await expect(repository.get("guild-1", "channel-1")).resolves.toEqual(denyAllCapabilities("guild-1", "channel-1"));
    await expect(sql`select * from channel_capabilities`).resolves.toHaveLength(0);
  });

  it("round-trips capabilities and records the change audit", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);
    const value: ChannelCapabilities = {
      guildId: "guild-1",
      channelId: "channel-1",
      observeEvents: true,
      respondToMentions: true,
      spontaneousJoin: false,
      spontaneousTopic: true,
      addReactions: false,
      createThreads: true,
      shareFiles: false,
      shareExternalLinks: true,
    };
    const now = new Date("2026-01-02T03:04:05.000Z");

    await repository.set(value, "operator-1", "enable channel", now);

    await expect(repository.get(value.guildId, value.channelId)).resolves.toEqual(value);
    const rows = await sql<{ summary: Record<string, unknown>; created_at: Date; category: string }[]>`
      select category, summary, created_at from audit_entries
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "channel.capability.changed",
      created_at: now,
      summary: {
        actor: "operator-1",
        reason: "enable channel",
        guildId: value.guildId,
        channelId: value.channelId,
        before: denyAllCapabilities(value.guildId, value.channelId),
        after: value,
      },
    });
  });

  it("serializes concurrent first writes for one channel scope", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresChannelCapabilityRepository(firstSql);
    const second = new PostgresChannelCapabilityRepository(secondSql);
    const scope = { guildId: "concurrent-guild", channelId: "concurrent-channel" };
    const firstValue: ChannelCapabilities = {
      ...denyAllCapabilities(scope.guildId, scope.channelId),
      observeEvents: true,
    };
    const secondValue: ChannelCapabilities = {
      ...denyAllCapabilities(scope.guildId, scope.channelId),
      shareFiles: true,
    };
    const now = new Date("2026-01-02T03:04:05.000Z");

    try {
      await Promise.all([
        first.set(firstValue, "actor-1", "first", now),
        second.set(secondValue, "actor-2", "second", now),
      ]);

      const auditRows = await sql<
        { summary: { actor: string; before: ChannelCapabilities; after: ChannelCapabilities } }[]
      >`
        select summary from audit_entries where category = 'channel.capability.changed' order by id
      `;
      expect(auditRows).toHaveLength(2);
      const isDenyAll = (value: ChannelCapabilities) =>
        value.guildId === scope.guildId &&
        value.channelId === scope.channelId &&
        !value.observeEvents &&
        !value.respondToMentions &&
        !value.spontaneousJoin &&
        !value.spontaneousTopic &&
        !value.addReactions &&
        !value.createThreads &&
        !value.shareFiles &&
        !value.shareExternalLinks;
      const denyAllAudit = auditRows.filter((row) => isDenyAll(row.summary.before));
      expect(denyAllAudit).toHaveLength(1);
      const otherAudit = auditRows.find((row) => !isDenyAll(row.summary.before));
      expect(otherAudit?.summary.before).toEqual(
        expect.objectContaining({ guildId: scope.guildId, channelId: scope.channelId }),
      );
      expect(otherAudit?.summary.before).toEqual(denyAllAudit[0]?.summary.after);
      const finalValue = await first.get(scope.guildId, scope.channelId);
      expect(finalValue).toEqual(expect.anything());
      expect([firstValue, secondValue]).toContainEqual(finalValue);
      expect(auditRows.map((row) => row.summary.after)).toContainEqual(finalValue);
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });

  it("merges concurrent patches and preserves the audit chain", async () => {
    const firstSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const secondSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const first = new PostgresChannelCapabilityRepository(firstSql);
    const second = new PostgresChannelCapabilityRepository(secondSql);
    const scope = { guildId: "patch-guild", channelId: "patch-channel" };
    const firstPatch: ChannelCapabilitiesPatch = { observeEvents: true };
    const secondPatch: ChannelCapabilitiesPatch = { shareFiles: true };
    const now = new Date("2026-01-02T03:04:05.000Z");

    try {
      const results = await Promise.all([
        first.patch(scope.guildId, scope.channelId, firstPatch, " actor-1 ", " first ", now),
        second.patch(scope.guildId, scope.channelId, secondPatch, "actor-2", "second", now),
      ]);
      const finalValue = await first.get(scope.guildId, scope.channelId);
      const auditRows = await sql<
        { summary: { before: ChannelCapabilities; after: ChannelCapabilities; actor: string; reason: string } }[]
      >`
        select summary from audit_entries where category = 'channel.capability.changed'
      `;

      expect(finalValue).toEqual({
        ...denyAllCapabilities(scope.guildId, scope.channelId),
        observeEvents: true,
        shareFiles: true,
      });
      expect(results).toContainEqual(finalValue);
      expect(auditRows).toHaveLength(2);
      const firstAudit = auditRows.find(
        (row) => row.summary.before.observeEvents === false && row.summary.before.shareFiles === false,
      );
      const secondAudit = auditRows.find((row) => row !== firstAudit);
      expect(firstAudit?.summary.before).toEqual(denyAllCapabilities(scope.guildId, scope.channelId));
      expect(secondAudit?.summary.before).toEqual(firstAudit?.summary.after);
      expect(secondAudit?.summary.after).toEqual(finalValue);
      expect(auditRows.map((row) => [row.summary.actor, row.summary.reason])).toEqual(
        expect.arrayContaining([
          ["actor-1", "first"],
          ["actor-2", "second"],
        ]),
      );
    } finally {
      await firstSql.end();
      await secondSql.end();
    }
  });

  it("uses patch arguments as scope and rejects invalid metadata", async () => {
    const repository = new PostgresChannelCapabilityRepository(sql);
    const now = new Date("2026-01-02T03:04:05.000Z");

    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, " ", "reason", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, "actor", " ", now),
    ).rejects.toThrow();
    await expect(
      repository.patch("guild-1", "channel-1", { observeEvents: true }, "actor", "reason", new Date("invalid")),
    ).rejects.toThrow();
    await repository.patch("guild-1", "channel-1", { observeEvents: true }, " actor ", " reason ", now);
    await expect(repository.get("guild-2", "channel-2")).resolves.toEqual(denyAllCapabilities("guild-2", "channel-2"));
  });
});

describe("PostgresIngestionStore", () => {
  it("stores an event and queues only the first event for a duplicate key", async () => {
    const store = new PostgresIngestionStore(sql);
    const event: CanonicalMessageEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 1,
      source: "discord",
      externalEventId: "external-1",
      externalVersion: "version-1",
      kind: "message.created",
      visibility: "observed",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: null,
      actorId: "actor-1",
      actorKind: "human",
      occurredAt: new Date("2026-01-02T03:00:00.000Z"),
      receivedAt: new Date("2026-01-02T03:04:05.000Z"),
      content: {
        text: "hello",
        mentionedBot: true,
        mentionIds: ["bot-1"],
        replyToMessageId: null,
        attachments: [
          { id: "attachment-1", name: "a.txt", contentType: "text/plain", url: "https://example.test/a", size: 5 },
        ],
      },
      expiresAt: new Date("2026-02-01T03:04:05.000Z"),
    };
    const job: MentionResponseJobInput = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "mention_response",
      eventId: event.id,
      priority: 100,
      availableAt: event.receivedAt,
      maxAttempts: 3,
    };
    const duplicateEvent = {
      ...event,
      id: "33333333-3333-4333-8333-333333333333",
      content: { ...event.content, text: "ignored" },
    };

    await expect(store.saveEventAndMaybeEnqueue(event, job)).resolves.toEqual({ eventId: event.id, duplicate: false });
    await expect(
      store.saveEventAndMaybeEnqueue(duplicateEvent, {
        ...job,
        id: "44444444-4444-4444-8444-444444444444",
        eventId: duplicateEvent.id,
      }),
    ).resolves.toEqual({ eventId: event.id, duplicate: true });

    await expect(sql`select id, content from events`).resolves.toEqual([{ id: event.id, content: event.content }]);
    await expect(
      sql`select id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at from jobs`,
    ).resolves.toEqual([
      {
        id: job.id,
        kind: job.kind,
        event_id: event.id,
        priority: 100,
        state: "queued",
        available_at: job.availableAt,
        attempts: 0,
        max_attempts: 3,
        created_at: event.receivedAt,
        updated_at: event.receivedAt,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the PostgreSQL specification and verify it fails**

Run: `nix develop -c pnpm test:spec`

Expected: FAIL because the PostgreSQL repositories do not exist.

- [ ] **Step 3: Implement the channel capability repository**

`src/adapters/postgres/channel-capability-repository.ts`:

```ts
import type { Sql, TransactionSql } from "postgres";
import { newId } from "../../shared/ids.js";
import { denyAllCapabilities, type ChannelCapabilities } from "../../modules/channels/channel-capability.js";

type CapabilityRow = ChannelCapabilities & { updatedAt: Date; updatedBy: string; reason: string };

export type ChannelCapabilitiesPatch = Partial<
  Pick<
    ChannelCapabilities,
    | "observeEvents"
    | "respondToMentions"
    | "spontaneousJoin"
    | "spontaneousTopic"
    | "addReactions"
    | "createThreads"
    | "shareFiles"
    | "shareExternalLinks"
  >
>;

function mapRow(row: Record<string, unknown>): ChannelCapabilities {
  return {
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    observeEvents: row.observe_events as boolean,
    respondToMentions: row.respond_to_mentions as boolean,
    spontaneousJoin: row.spontaneous_join as boolean,
    spontaneousTopic: row.spontaneous_topic as boolean,
    addReactions: row.add_reactions as boolean,
    createThreads: row.create_threads as boolean,
    shareFiles: row.share_files as boolean,
    shareExternalLinks: row.share_external_links as boolean,
  };
}

export class PostgresChannelCapabilityRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(guildId: string, channelId: string): Promise<ChannelCapabilities> {
    const rows = await this
      .sql`select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId}`;
    return rows[0] ? mapRow(rows[0]) : denyAllCapabilities(guildId, channelId);
  }

  public async set(value: ChannelCapabilities, actor: string, reason: string, now: Date): Promise<void> {
    validateMetadata(actor, reason, now);
    await this.sql.begin(async (transaction) => {
      await persist(transaction, value.guildId, value.channelId, value, actor.trim(), reason.trim(), now);
    });
  }

  public async patch(
    guildId: string,
    channelId: string,
    patch: ChannelCapabilitiesPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ChannelCapabilities> {
    validateMetadata(actor, reason, now);
    return this.sql.begin(async (transaction) => {
      await transaction`
        select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}`}, 84623817))
      `;
      const rows = await transaction<CapabilityRow[]>`
        select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId} for update
      `;
      const before = rows[0]
        ? mapRow(rows[0] as unknown as Record<string, unknown>)
        : denyAllCapabilities(guildId, channelId);
      const next = { ...before, ...patch, guildId, channelId };
      await persist(transaction, guildId, channelId, next, actor.trim(), reason.trim(), now, before);
      return next;
    });
  }
}

function validateMetadata(actor: string, reason: string, now: Date): void {
  if (!actor.trim() || !reason.trim()) throw new Error("actor and reason must be nonblank");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
}

async function persist(
  transaction: TransactionSql,
  guildId: string,
  channelId: string,
  value: ChannelCapabilities,
  actor: string,
  reason: string,
  now: Date,
  knownBefore?: ChannelCapabilities,
): Promise<void> {
  await transaction`
    select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${channelId}`}, 84623817))
  `;
  const beforeRows = knownBefore
    ? []
    : await transaction<CapabilityRow[]>`
        select * from channel_capabilities where guild_id = ${guildId} and channel_id = ${channelId} for update
      `;
  const before =
    knownBefore ??
    (beforeRows[0]
      ? mapRow(beforeRows[0] as unknown as Record<string, unknown>)
      : denyAllCapabilities(guildId, channelId));
  await transaction`
    insert into channel_capabilities (
      guild_id, channel_id, observe_events, respond_to_mentions, spontaneous_join, spontaneous_topic,
      add_reactions, create_threads, share_files, share_external_links, updated_at, updated_by, reason
    ) values (
      ${guildId}, ${channelId}, ${value.observeEvents}, ${value.respondToMentions}, ${value.spontaneousJoin}, ${value.spontaneousTopic},
      ${value.addReactions}, ${value.createThreads}, ${value.shareFiles}, ${value.shareExternalLinks}, ${now}, ${actor}, ${reason}
    ) on conflict (guild_id, channel_id) do update set
      observe_events = excluded.observe_events, respond_to_mentions = excluded.respond_to_mentions,
      spontaneous_join = excluded.spontaneous_join, spontaneous_topic = excluded.spontaneous_topic,
      add_reactions = excluded.add_reactions, create_threads = excluded.create_threads,
      share_files = excluded.share_files, share_external_links = excluded.share_external_links,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, reason = excluded.reason
  `;
  await transaction`
    insert into audit_entries (id, category, summary, created_at)
    values (${newId()}, 'channel.capability.changed', ${transaction.json(JSON.parse(JSON.stringify({ actor, reason, guildId, channelId, before, after: value })))}, ${now})
  `;
}
```

- [ ] **Step 4: Implement atomic event and job insertion**

`src/adapters/postgres/ingestion-store.ts`:

```ts
import type { Sql } from "postgres";
import type { CanonicalMessageEvent } from "../../modules/events/canonical-event.js";
import type { IngestionStore, MentionResponseJobInput } from "../../modules/events/ingest-message.js";

export class PostgresIngestionStore implements IngestionStore {
  constructor(private readonly sql: Sql) {}

  async saveEventAndMaybeEnqueue(
    event: CanonicalMessageEvent,
    job: MentionResponseJobInput | null,
  ): Promise<{ eventId: string; duplicate: boolean }> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<{ id: string }[]>`
        insert into events (
          id, schema_version, source, external_event_id, external_version, kind, visibility,
          guild_id, channel_id, thread_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at
        ) values (
          ${event.id}, ${event.schemaVersion}, ${event.source}, ${event.externalEventId}, ${event.externalVersion},
          ${event.kind}, ${event.visibility}, ${event.guildId}, ${event.channelId}, ${event.threadId},
          ${event.actorId}, ${event.actorKind}, ${event.occurredAt}, ${event.receivedAt},
          ${transaction.json(event.content)}, ${event.expiresAt}
        )
        on conflict (source, external_event_id, external_version) do nothing
        returning id
      `;
      if (!inserted[0]) {
        const existing = await transaction<{ id: string }[]>`
          select id from events
          where source = ${event.source} and external_event_id = ${event.externalEventId}
            and external_version = ${event.externalVersion}
        `;
        if (!existing[0]) throw new Error("Conflicting event disappeared during ingestion");
        return { eventId: existing[0].id, duplicate: true };
      }
      if (job) {
        await transaction`
          insert into jobs (
            id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at
          ) values (
            ${job.id}, ${job.kind}, ${inserted[0].id}, ${job.priority}, 'queued', ${job.availableAt}, 0,
            ${job.maxAttempts}, ${event.receivedAt}, ${event.receivedAt}
          )
        `;
      }
      return { eventId: inserted[0].id, duplicate: false };
    });
  }
}
```

- [ ] **Step 5: Run repository specifications**

Run: `nix develop -c pnpm test:spec`

Expected: migration and ingestion PostgreSQL specifications PASS.

- [ ] **Step 6: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 5: Implement the Durable Job Queue and System Controls

**Files:**

- Create: `src/modules/jobs/job-queue.ts`
- Create: `src/adapters/postgres/job-queue.ts`
- Create: `src/adapters/postgres/system-control-repository.ts`
- Create: `spec/adapters/postgres/job-queue.spec.ts`

- [ ] **Step 1: Write the failing lease and stop-mode specification**

`spec/adapters/postgres/job-queue.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresJobQueue } from "../../../src/adapters/postgres/job-queue.js";
import { PostgresSystemControlRepository } from "../../../src/adapters/postgres/system-control-repository.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-01-02T03:04:05.000Z");
let sql: Sql;

async function insertJob(
  id: string,
  event: string,
  values: { priority: number; createdAt: Date; availableAt?: Date; attempts?: number; maxAttempts?: number },
) {
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${event}, 1, 'discord', ${event}, '1', 'message.created', 'mention_only', 'g', 'c', 'a', 'human', ${now}, ${now}, ${sql.json({ text: event })}, ${new Date("2026-02-01T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at) values (${id}, 'mention_response', ${event}, ${values.priority}, 'queued', ${values.availableAt ?? now}, ${values.attempts ?? 0}, ${values.maxAttempts ?? 3}, ${values.createdAt}, ${now})`;
}

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});

beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
  await sql`update system_state set mode = 'running', updated_at = ${now}, updated_by = 'test', reason = 'reset'`;
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${eventId}, 1, 'discord', 'external', '1', 'message.created', 'mention_only', 'g', 'c', 'a', 'human', ${now}, ${now}, ${sql.json({ text: "hi" })}, ${new Date("2026-02-01T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, event_id, priority, state, available_at, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'mention_response', ${eventId}, 10, 'queued', ${now}, 0, 3, ${now}, ${now})`;
});

afterAll(async () => sql.end());

describe("PostgresJobQueue", () => {
  it("atomically gives one queued job to concurrent claimers", async () => {
    const a = new PostgresJobQueue(sql);
    const [first, second] = await Promise.all([a.claim("worker-a", now, 60_000), a.claim("worker-b", now, 60_000)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({
      id: jobId,
      kind: "mention_response",
      eventId,
      attempts: 1,
      maxAttempts: 3,
    });
    expect((first ?? second)?.leaseToken).toEqual(expect.any(String));
  });

  it("claims eligible jobs by priority then creation time and skips future or exhausted jobs", async () => {
    await sql`delete from jobs where id = ${jobId}`;
    await sql`delete from events where id = ${eventId}`;
    await insertJob("33333333-3333-4333-8333-333333333333", "33333333-3333-4333-8333-333333333333", {
      priority: 1,
      createdAt: new Date(now.getTime() - 1000),
    });
    await insertJob("44444444-4444-4444-8444-444444444444", "44444444-4444-4444-8444-444444444444", {
      priority: 10,
      createdAt: new Date(now.getTime() + 1000),
    });
    await insertJob("55555555-5555-4555-8555-555555555555", "55555555-5555-4555-8555-555555555555", {
      priority: 10,
      createdAt: now,
    });
    await insertJob("66666666-6666-4666-8666-666666666666", "66666666-6666-4666-8666-666666666666", {
      priority: 100,
      createdAt: now,
      availableAt: new Date(now.getTime() + 1000),
    });
    await insertJob("77777777-7777-4777-8777-777777777777", "77777777-7777-4777-8777-777777777777", {
      priority: 100,
      createdAt: now,
      attempts: 3,
      maxAttempts: 3,
    });
    const queue = new PostgresJobQueue(sql);
    const first = await queue.claim("worker", now, 60_000);
    expect(first).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
    });
    await queue.succeed(first!.id, first!.leaseToken, now);
    const second = await queue.claim("worker", now, 60_000);
    expect(second).toMatchObject({
      id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it.each(["draining", "stopped"])("does not claim while system is %s", async (mode) => {
    await sql`update system_state set mode = ${mode}`;
    await expect(new PostgresJobQueue(sql).claim("worker", now, 60_000)).resolves.toBeNull();
  });

  it("uses the committed system mode as a transaction barrier", async () => {
    const controlSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const queueSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    try {
      const control = new PostgresSystemControlRepository(controlSql);
      await control.setMode("stopped", "operator", "stop first", now);
      await expect(new PostgresJobQueue(queueSql).claim("worker", now, 60_000)).resolves.toBeNull();
      await control.setMode("running", "operator", "resume", now);
      await expect(new PostgresJobQueue(queueSql).claim("worker", now, 60_000)).resolves.toMatchObject({ id: jobId });
    } finally {
      await controlSql.end();
      await queueSql.end();
    }
  });

  it("holds the shared mode lock until claim commits before setMode can commit", async () => {
    const controlSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    const queueSql = createPostgresClient(process.env.TEST_DATABASE_URL!);
    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    try {
      await sql.unsafe(
        `create function test_claim_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(735102); return new; end $$`,
      );
      await sql.unsafe(
        "create trigger test_claim_barrier before update on jobs for each row execute function test_claim_barrier()",
      );
      const blocker = controlSql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(735102)`;
        await blockerReleased;
      });
      for (;;) {
        const locks = await sql<
          { granted: boolean }[]
        >`select granted from pg_locks where locktype = 'advisory' and classid = 0 and objid = 735102`;
        if (locks.some((lock) => lock.granted)) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const queuePid = (await queueSql<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      const claim = new PostgresJobQueue(queueSql).claim("worker", now, 60_000);
      for (;;) {
        const locks = await sql<{ mode: string; granted: boolean }[]>`
          select mode, granted from pg_locks
          where pid = ${queuePid} and relation = 'system_state'::regclass
        `;
        const hasSharedLock = locks.some((lock) => lock.granted && lock.mode === "RowShareLock");
        const waitsForJobUpdate = (
          await sql<
            { granted: boolean }[]
          >`select granted from pg_locks where pid = ${queuePid} and locktype = 'advisory' and objid = 735102`
        ).some((lock) => !lock.granted);
        if (hasSharedLock && waitsForJobUpdate) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const modeChange = new PostgresSystemControlRepository(controlSql).setMode("stopped", "operator", "stop", now);
      releaseBlocker();
      await expect(claim).resolves.toMatchObject({ id: jobId });
      await expect(modeChange).resolves.toMatchObject({ mode: "stopped" });
      await blocker;
    } finally {
      releaseBlocker();
      await sql`drop trigger if exists test_claim_barrier on jobs`;
      await sql`drop function if exists test_claim_barrier()`;
      await controlSql.end();
      await queueSql.end();
    }
  });

  it("reclaims an expired lease as the next attempt", async () => {
    await sql`update jobs set state = 'running', lease_owner = 'old', leased_until = ${new Date(now.getTime() - 1)}, attempts = 1`;
    await expect(new PostgresJobQueue(sql).claim("worker", now, 60_000)).resolves.toMatchObject({ attempts: 2 });
  });

  it("succeeds and handles retryable and terminal failures", async () => {
    const queue = new PostgresJobQueue(sql);
    const first = (await queue.claim("worker", now, 60_000))!;
    const retryNotYet = new Date(now.getTime() + 999);
    const retryAt = new Date(now.getTime() + 1000);
    await queue.fail(jobId, first.leaseToken, "x".repeat(2100), true, now);
    await expect(sql`select state, attempts, last_error, leased_until, lease_owner from jobs`).resolves.toMatchObject([
      { state: "queued", attempts: 1, leased_until: null, lease_owner: null, last_error: "x".repeat(2000) },
    ]);
    await expect(queue.claim("worker", retryNotYet, 60_000)).resolves.toBeNull();
    const second = (await queue.claim("worker", retryAt, 60_000))!;
    await queue.succeed(jobId, second.leaseToken, retryAt);
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "succeeded", leased_until: null, lease_owner: null },
    ]);
  });

  it("fails non-retryable jobs and jobs at their attempt limit", async () => {
    const queue = new PostgresJobQueue(sql);
    const claimed = (await queue.claim("worker", now, 60_000))!;
    await queue.fail(jobId, claimed.leaseToken, "terminal", false, now);
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "failed", leased_until: null, lease_owner: null },
    ]);
    await sql`update jobs set state = 'running', attempts = max_attempts, lease_owner = 'worker', lease_token = ${claimed.leaseToken}, leased_until = ${new Date(now.getTime() + 1000)}`;
    await queue.fail(jobId, claimed.leaseToken, "limit", true, now);
    await expect(sql`select state, leased_until, lease_owner from jobs`).resolves.toEqual([
      { state: "failed", leased_until: null, lease_owner: null },
    ]);
  });

  it("fences an expired worker after another worker reclaims the job", async () => {
    const queue = new PostgresJobQueue(sql);
    const first = (await queue.claim("worker-a", now, 1))!;
    const reclaimedAt = new Date(now.getTime() + 2);
    const second = (await queue.claim("worker-b", reclaimedAt, 60_000))!;
    await expect(queue.succeed(jobId, first.leaseToken, new Date(now.getTime() + 2))).rejects.toThrow(/lease lost/i);
    await expect(queue.fail(jobId, first.leaseToken, "stale", true, new Date(now.getTime() + 2))).rejects.toThrow(
      /lease lost/i,
    );
    await expect(sql`select state, lease_owner, lease_token from jobs`).resolves.toEqual([
      { state: "running", lease_owner: "worker-b", lease_token: second.leaseToken },
    ]);
    await expect(queue.succeed(jobId, second.leaseToken, new Date(now.getTime() + 2))).resolves.toBeUndefined();
  });

  it("rejects expired completion and finalizes an exhausted lease", async () => {
    const queue = new PostgresJobQueue(sql);
    const claimed = (await queue.claim("worker", now, 1))!;
    await expect(queue.succeed(jobId, claimed.leaseToken, new Date(now.getTime() + 2))).rejects.toThrow(/lease lost/i);
    await sql`update jobs set attempts = max_attempts, leased_until = ${new Date(now.getTime() - 1)}`;
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    await expect(
      sql`select state, lease_owner, leased_until, lease_token, last_error from jobs`,
    ).resolves.toMatchObject([
      {
        state: "failed",
        lease_owner: null,
        leased_until: null,
        lease_token: null,
        last_error: expect.stringContaining("expired"),
      },
    ]);
  });

  it("validates claim and completion inputs", async () => {
    const queue = new PostgresJobQueue(sql);
    const invalidDate = new Date("invalid");
    await expect(queue.claim(" ", now, 1)).rejects.toThrow();
    await expect(queue.claim("worker", now, 0)).rejects.toThrow();
    await expect(queue.claim("worker", invalidDate, 1)).rejects.toThrow();
    await expect(queue.succeed(jobId, " ", now)).rejects.toThrow();
    await expect(queue.fail(jobId, " ", "error", true, now)).rejects.toThrow();
  });
});

describe("PostgresSystemControlRepository", () => {
  it("changes mode and records an audit entry, validating actor and reason", async () => {
    const repository = new PostgresSystemControlRepository(sql);
    await expect(repository.setMode("draining", "operator", "maintenance", now)).resolves.toEqual({
      mode: "draining",
      updatedAt: now,
      updatedBy: "operator",
      reason: "maintenance",
    });
    await expect(sql`select category, summary, created_at from audit_entries`).resolves.toMatchObject([
      {
        category: "system.mode.changed",
        created_at: now,
        summary: { actor: "operator", reason: "maintenance", before: "running", after: "draining" },
      },
    ]);
    await expect(repository.setMode("running", "", "reason", now)).rejects.toThrow();
    await expect(repository.setMode("running", "operator", "   ", now)).rejects.toThrow();
    await expect(repository.setMode("running", "operator", "reason", new Date("invalid"))).rejects.toThrow();
    await expect(repository.get()).resolves.toMatchObject({ mode: "draining" });
  });
});
```

- [ ] **Step 2: Run the queue specification and verify it fails**

Run: `nix develop -c pnpm test:spec`

Expected: FAIL because the queue and system repositories do not exist.

- [ ] **Step 3: Define the job queue port**

`src/modules/jobs/job-queue.ts`:

```ts
export interface ClaimedJob {
  id: string;
  kind: "mention_response";
  eventId: string;
  attempts: number;
  maxAttempts: number;
  leasedUntil: Date;
  leaseToken: string;
}

export interface JobQueue {
  claim(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null>;
  succeed(jobId: string, leaseToken: string, now: Date): Promise<void>;
  fail(jobId: string, leaseToken: string, error: string, retryable: boolean, now: Date): Promise<void>;
}
```

- [ ] **Step 4: Implement system controls**

`src/adapters/postgres/system-control-repository.ts`:

```ts
import type { Sql } from "postgres";
import type { SystemMode, SystemState } from "../../modules/system/system-control.js";

export class PostgresSystemControlRepository {
  public constructor(private readonly sql: Sql) {}

  public async get(): Promise<SystemState> {
    const rows = await this.sql<SystemState[]>`select mode, updated_at as "updatedAt", updated_by as "updatedBy", reason from system_state where singleton`;
    if (!rows[0]) throw new Error("System state singleton is missing");
    return rows[0];
  }

  public async setMode(mode: SystemMode, actor: string, reason: string, now: Date): Promise<SystemState> {
    if (!actor.trim() || !reason.trim()) throw new Error("Actor and reason are required");
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<SystemState[]>`select mode, updated_at as "updatedAt", updated_by as "updatedBy", reason from system_state where singleton for update`;
      if (!rows[0]) throw new Error("System state singleton is missing");
      const before = rows[0].mode;
      const updated = (await transaction<SystemState[]>`update system_state set mode = ${mode}, updated_at = ${now}, updated_by = ${actor}, reason = ${reason} where singleton returning mode, updated_at as "updatedAt", updated_by as "updatedBy", reason`)[0]!;
      await transaction`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'system.mode.changed', ${transaction.json({ actor, reason, before, after: mode })}, ${now})`;
      return updated;
    });
  }
}
```

- [ ] **Step 5: Implement lease claiming, success, and failure**

`src/adapters/postgres/job-queue.ts`:

```ts
import type { Sql } from "postgres";
import type { ClaimedJob, JobQueue } from "../../modules/jobs/job-queue.js";

function assertDate(value: Date, name: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid date`);
}

function assertLeaseToken(value: string): void {
  if (!value.trim()) throw new Error("Lease token is required");
}

export class PostgresJobQueue implements JobQueue {
  public constructor(private readonly sql: Sql) {}

  public async claim(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    if (!workerId.trim()) throw new Error("Worker ID is required");
    assertDate(now, "now");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Lease duration must be finite and positive");
    const leasedUntil = new Date(now.getTime() + leaseMs);
    assertDate(leasedUntil, "leasedUntil");
    return this.sql.begin(async (transaction) => {
      const mode = await transaction<{ mode: string }[]>`select mode from system_state where singleton for share`;
      if (!mode[0]) throw new Error("System state singleton is missing");
      if (mode[0].mode !== "running") return null;
      await transaction`
        update jobs set state = 'failed', last_error = 'lease expired at maximum attempts', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
        where state = 'running' and leased_until < ${now} and attempts >= max_attempts
      `;
      const rows = await transaction<ClaimedJob[]>`
        with candidate as (
          select j.id from jobs j
          where j.attempts < j.max_attempts
            and (j.state = 'queued' and j.available_at <= ${now} or j.state = 'running' and j.leased_until < ${now})
          order by j.priority desc, j.created_at
          for update skip locked limit 1
        )
        update jobs j set state = 'running', lease_owner = ${workerId}, lease_token = gen_random_uuid(), leased_until = ${leasedUntil}, attempts = j.attempts + 1, updated_at = ${now}
        from candidate c where j.id = c.id
        returning j.id, j.kind, j.event_id as "eventId", j.attempts, j.max_attempts as "maxAttempts", j.leased_until as "leasedUntil", j.lease_token as "leaseToken"
      `;
      return rows[0] ?? null;
    });
  }

  public async succeed(jobId: string, leaseToken: string, now: Date): Promise<void> {
    assertLeaseToken(leaseToken);
    assertDate(now, "now");
    const rows = await this.sql<{ id: string }[]>`
      update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
      where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now}
      returning id
    `;
    if (!rows[0]) throw new Error("Job lease lost");
  }

  public async fail(jobId: string, leaseToken: string, error: string, retryable: boolean, now: Date): Promise<void> {
    assertLeaseToken(leaseToken);
    assertDate(now, "now");
    const rows = await this.sql<{ id: string }[]>`
      update jobs set state = case when ${retryable} and attempts < max_attempts then 'queued' else 'failed' end,
        available_at = case when ${retryable} and attempts < max_attempts then ${new Date(now.getTime() + 1000)} else available_at end,
        last_error = ${error.slice(0, 2000)}, leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now}
      where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now}
      returning id
    `;
    if (!rows[0]) throw new Error("Job lease lost");
  }
}
```

- [ ] **Step 6: Run lease and control specifications**

Run: `nix develop -c pnpm test:spec`

Expected: all job queue tests PASS, including concurrent claim and expired lease recovery.

- [ ] **Step 7: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.
## Task 6: Add Character Definitions, Model Routes, and the pi Agent Adapter

**Files:**

- Create: `src/modules/characters/character-definition.ts`
- Create: `src/modules/models/agent-runtime.ts`
- Create: `src/config/model-routes.ts`
- Create: `config/model-routes.example.json`
- Create: `src/adapters/postgres/character-repository.ts`
- Create: `src/adapters/pi/pi-agent-runtime.ts`
- Create: `src/adapters/pi/pi-models.ts`
- Create: `src/modules/characters/character-definition.test.ts`
- Create: `src/config/model-routes.test.ts`
- Create: `src/adapters/pi/pi-agent-runtime.test.ts`
- Create: `spec/adapters/postgres/character-repository.spec.ts`

- [ ] **Step 1: Write failing character and pi adapter tests**

`src/modules/characters/character-definition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CharacterDefinitionSchema } from "./character-definition.js";

describe("CharacterDefinition", () => {
  it("requires a Japanese production contract with fallback messages", () => {
    expect(
      CharacterDefinitionSchema.parse({
        schemaVersion: 1,
        characterId: "primary",
        version: 1,
        name: "テストキャラクター",
        language: "ja",
        systemPrompt: "あなたはDiscordコミュニティで暮らすキャラクターです。",
        failureMessages: ["今ちょっとうまく考えられない。あとでまた呼んで。"],
      }),
    ).toMatchObject({ characterId: "primary", version: 1, language: "ja" });
  });

  it("rejects empty fallback messages", () => {
    expect(() =>
      CharacterDefinitionSchema.parse({
        schemaVersion: 1,
        characterId: "primary",
        version: 1,
        name: "テスト",
        language: "ja",
        systemPrompt: "テスト用人格",
        failureMessages: [],
      }),
    ).toThrow();
  });
});
```

`src/adapters/pi/pi-agent-runtime.test.ts`:

```ts
import { expect, test } from "vitest";
import { PiAgentRuntime } from "./pi-agent-runtime.js";
import { AgentRunError } from "../../modules/models/agent-runtime.js";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

test("exposes only faux text and usage", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux" }] });
  const usage = {
    input: 5,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = Object.assign(fauxAssistantMessage([fauxThinking("hidden"), fauxText("hello")]), {
    provider: "faux",
    model: "faux",
    responseModel: "faux-response",
    usage,
  });
  faux.setResponses([message]);
  const models = createModels();
  models.setProvider(faux.provider);
  const result = await new PiAgentRuntime(models).run({
    provider: "faux",
    model: "faux",
    thinkingLevel: "minimal",
    timeoutMs: 5000,
    systemPrompt: "x",
    userPrompt: "hello",
  });
  expect(result.text).toBe("hello");
  expect(result.provider).toBe("faux");
  expect(result.model).toBe("faux");
  expect(result.responseModel).toBe("faux-response");
  expect(result.usage).toEqual(usage);
  expect(JSON.stringify(result)).not.toContain("hidden");
});

test("copies optional pi usage fields when present", async () => {
  const base = createModels();
  const model = fauxProvider({ provider: "faux-usage", models: [{ id: "faux" }] });
  base.setProvider(model.provider);
  const models = Object.create(base) as ReturnType<typeof createModels>;
  models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = Object.assign(fauxAssistantMessage([fauxText("hello")]), {
      provider: "faux-usage",
      model: "faux",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cacheWrite1h: 5,
        reasoning: 6,
        totalTokens: 10,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  const result = await new PiAgentRuntime(models).run({
    provider: "faux-usage",
    model: "faux",
    thinkingLevel: "off",
    timeoutMs: 5000,
    systemPrompt: "x",
    userPrompt: "u",
  });
  expect(result.usage).toEqual({
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    cacheWrite1h: 5,
    reasoning: 6,
    totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
});

test("aborts a pending faux response through the runtime timeout listener", async () => {
  const faux = fauxProvider({ provider: "faux-timeout", models: [{ id: "faux" }] });
  faux.setResponses([
    async (_context, options) =>
      await new Promise((resolve) =>
        options?.signal?.addEventListener("abort", () =>
          resolve(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "timed out" })),
        ),
      ),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-timeout",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 20,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "faux-timeout", model: "faux", stopReason: "aborted" });
});

test("rejects an unknown model with exact error metadata", async () => {
  const models = createModels();
  await expect(
    new PiAgentRuntime(models).run({
      provider: "missing",
      model: "missing",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "missing", model: "missing", stopReason: "error" });
});

test("rejects untrusted request boundaries before model use", async () => {
  const models = createModels();
  for (const request of [
    { provider: " ", model: "m", thinkingLevel: "off", timeoutMs: 1000, systemPrompt: "s", userPrompt: "u" },
    { provider: "p", model: "m", thinkingLevel: "off", timeoutMs: 30001, systemPrompt: "s", userPrompt: "u" },
    { provider: "p", model: "m", thinkingLevel: "off", timeoutMs: 1000, systemPrompt: " ", userPrompt: "u" },
  ])
    await expect(new PiAgentRuntime(models).run(request as never)).rejects.toMatchObject({
      provider: request.provider,
      model: request.model,
      stopReason: "error",
    });
});

test("classifies non-stop responses and prefers provider error messages", async () => {
  const faux = fauxProvider({ provider: "faux-error", models: [{ id: "faux" }] });
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider boom\nBearer abc.secret\u0000" }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-error",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({
    message: "Provider returned an unsuccessful response",
    provider: "faux-error",
    model: "faux",
    stopReason: "error",
  });
});

test("never exposes provider error text", async () => {
  for (const errorMessage of [
    "token=tok-secret",
    "api_key: key-secret",
    '{"secret":"json-secret"}',
    "Bearer bearer-secret",
    "raw\u0000provider\u001ftext",
  ]) {
    const provider = `faux-${errorMessage.length}`;
    const faux = fauxProvider({ provider, models: [{ id: "faux" }] });
    const base = createModels();
    base.setProvider(faux.provider);
    const models = Object.create(base) as ReturnType<typeof createModels>;
    models.streamSimple = () => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage([], { stopReason: "error", errorMessage });
      queueMicrotask(() => stream.push({ type: "error", reason: "error", error: message }));
      return stream;
    };
    const error = await new PiAgentRuntime(models)
      .run({
        provider,
        model: "faux",
        thinkingLevel: "off",
        timeoutMs: 5000,
        systemPrompt: "x",
        userPrompt: "u",
      })
      .catch((value: unknown) => value as Error);
    expect(error).toMatchObject({ message: "Provider returned an unsuccessful response", stopReason: "error" });
    expect(JSON.stringify(error)).not.toContain(errorMessage);
  }
});

test("rejects assistant metadata and unsafe usage", async () => {
  const faux = fauxProvider({ provider: "faux-bad", models: [{ id: "faux" }] });
  const base = createModels();
  base.setProvider(faux.provider);
  const models = Object.create(base) as ReturnType<typeof createModels>;
  models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = Object.assign(fauxAssistantMessage([fauxText("hello")]), {
      provider: "other",
      model: "faux",
      usage: {
        input: -1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        secret: "token",
      },
    });
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-bad",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({ provider: "faux-bad", model: "faux", stopReason: "error" });
});

test("classifies an aborted assistant message as aborted", async () => {
  const faux = fauxProvider({ provider: "faux-aborted", models: [{ id: "faux" }] });
  faux.setResponses([fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "cancelled" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  await expect(
    new PiAgentRuntime(models).run({
      provider: "faux-aborted",
      model: "faux",
      thinkingLevel: "off",
      timeoutMs: 5000,
      systemPrompt: "x",
      userPrompt: "hello",
    }),
  ).rejects.toMatchObject({
    message: "Provider returned an unsuccessful response",
    provider: "faux-aborted",
    model: "faux",
    stopReason: "aborted",
  } satisfies Partial<AgentRunError>);
});
```

`src/config/model-routes.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelRoutes } from "./model-routes.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("loadModelRoutes", () => {
  it("loads a bounded mention deadline and returns a stable version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vicissitude-routes-"));
    directories.push(directory);
    const path = join(directory, "routes.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      routes: {
        mention_response: {
          deadlineMs: 25_000,
          targets: [{ provider: "faux", model: "faux-1", thinkingLevel: "off", timeoutMs: 5_000 }],
        },
      },
    }));
    const first = await loadModelRoutes(path);
    const second = await loadModelRoutes(path);
    expect(first).toEqual(second);
    expect(first.mentionResponseDeadlineMs).toBe(25_000);
    expect(first.version).toMatch(/^[0-9a-f]{64}$/u);
  });
});
```

- [ ] **Step 2: Run unit tests and verify they fail**

Run: `nix develop -c pnpm test:unit`

Expected: FAIL because character and agent runtime modules do not exist.

- [ ] **Step 3: Implement the CharacterDefinition contract**

`src/modules/characters/character-definition.ts`:

```ts
import { z } from "zod";
import { createHash } from "node:crypto";

export const CharacterDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  characterId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  language: z.literal("ja"),
  systemPrompt: z.string().trim().min(1).max(20_000),
  failureMessages: z.array(z.string().trim().min(1).max(600)).min(1).max(10),
});

export type CharacterDefinition = z.infer<typeof CharacterDefinitionSchema>;

export interface CharacterDefinitionRepository {
  importDraft(definition: CharacterDefinition, actor: string, now: Date): Promise<void>;
  activate(characterId: string, version: number, actor: string, now: Date): Promise<void>;
  getProduction(characterId: string): Promise<CharacterDefinition | null>;
}
```

- [ ] **Step 4: Define model routes and agent runtime contracts**

`src/modules/models/agent-runtime.ts`:

```ts
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

export interface AgentRunRequest {
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
}

export interface AgentRunResult {
  text: string;
  provider: string;
  model: string;
  responseModel: string | null;
  usage: Usage;
  stopReason: "stop";
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    readonly stopReason: "error" | "aborted",
  ) {
    super(message);
  }
}

export interface AgentRuntime {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

`src/config/model-routes.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const ModelTargetSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  timeoutMs: z.number().int().min(1_000).max(30_000),
});

const ModelRoutesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routes: z.strictObject({
    mention_response: z.strictObject({
      deadlineMs: z.number().int().min(5_000).max(25_000),
      targets: z.array(ModelTargetSchema).min(1).max(5),
    }),
  }),
});

export type ModelTarget = z.infer<typeof ModelTargetSchema>;
export interface LoadedModelRoutes {
  version: string;
  mentionResponseDeadlineMs: number;
  mentionResponse: ModelTarget[];
}

export async function loadModelRoutes(path: string): Promise<LoadedModelRoutes> {
  const source = await readFile(path, "utf8");
  const parsed = ModelRoutesSchema.parse(JSON.parse(source));
  return {
    version: createHash("sha256").update(source).digest("hex"),
    mentionResponseDeadlineMs: parsed.routes.mention_response.deadlineMs,
    mentionResponse: parsed.routes.mention_response.targets,
  };
}
```

`config/model-routes.example.json`:

```json
{
  "schemaVersion": 1,
  "routes": {
    "mention_response": {
      "deadlineMs": 25000,
      "targets": [
        {
          "provider": "openai",
          "model": "gpt-5-mini",
          "thinkingLevel": "minimal",
          "timeoutMs": 20000
        }
      ]
    }
  }
}
```

- [ ] **Step 5: Implement the PostgreSQL CharacterDefinition repository**

`src/adapters/postgres/character-repository.ts`:

```ts
import type { Sql } from "postgres";
import {
  CharacterDefinitionSchema,
  type CharacterDefinition,
  type CharacterDefinitionRepository,
} from "../../modules/characters/character-definition.js";

export class PostgresCharacterRepository implements CharacterDefinitionRepository {
  public constructor(private readonly sql: Sql) {}
  public async importDraft(definition: CharacterDefinition, actor: string, now: Date): Promise<void> {
    const parsed = CharacterDefinitionSchema.parse(definition);
    await this.sql.begin(async (tx) => {
      await tx`insert into character_definitions (character_id, version, status, definition, created_at, created_by) values (${parsed.characterId}, ${parsed.version}, 'draft', ${tx.json(parsed)}, ${now}, ${actor})`;
      await tx`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'character.imported', ${tx.json({ actor, characterId: parsed.characterId, version: parsed.version })}, ${now})`;
    });
  }
  public async activate(characterId: string, version: number, actor: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${characterId}, 0))`;
      const target = await tx<
        { characterId: string; version: number; definition: unknown }[]
      >`select character_id as "characterId", version, definition from character_definitions where character_id=${characterId} and version=${version} for update`;
      if (!target[0]) throw new Error(`Character definition not found: ${characterId} v${version}`);
      const parsed = CharacterDefinitionSchema.parse(target[0].definition);
      if (parsed.characterId !== target[0].characterId || parsed.version !== target[0].version)
        throw new Error("Character definition identity corruption");
      const current = await tx<
        { version: number }[]
      >`select version from character_definitions where character_id=${characterId} and status='production' for update`;
      await tx`update character_definitions set status='retired' where character_id=${characterId} and status='production'`;
      await tx`update character_definitions set status='production' where character_id=${characterId} and version=${version}`;
      await tx`insert into audit_entries (id, category, summary, created_at) values (gen_random_uuid(), 'character.activated', ${tx.json({ actor, characterId, beforeVersion: current[0]?.version ?? null, afterVersion: version })}, ${now})`;
    });
  }
  public async getProduction(characterId: string): Promise<CharacterDefinition | null> {
    const rows = await this.sql<
      { characterId: string; version: number; definition: unknown }[]
    >`select character_id as "characterId", version, definition from character_definitions where character_id=${characterId} and status='production'`;
    if (!rows[0]) return null;
    const parsed = CharacterDefinitionSchema.parse(rows[0].definition);
    if (parsed.characterId !== rows[0].characterId || parsed.version !== rows[0].version)
      throw new Error("Character definition identity corruption");
    return parsed;
  }
}
```

`spec/adapters/postgres/character-repository.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresCharacterRepository } from "../../../src/adapters/postgres/character-repository.js";
import type { CharacterDefinition } from "../../../src/modules/characters/character-definition.js";

const now = new Date("2026-01-02T03:04:05.000Z");
const definition = (version: number): CharacterDefinition => ({
  schemaVersion: 1,
  characterId: "haru",
  version,
  name: "  春  ",
  language: "ja",
  systemPrompt: "  丁寧に答える  ",
  failureMessages: [" 失敗しました "],
});
let sql: Sql;
beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});
beforeEach(async () => {
  await sql`truncate character_definitions, audit_entries cascade`;
});
afterAll(async () => sql.end());
describe("PostgresCharacterRepository", () => {
  it("imports drafts, activates versions, retires previous production, and reads audits", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    expect(
      (await sql`select definition from character_definitions where character_id = 'haru' and version = 1`)[0]
        ?.definition,
    ).toMatchObject({ name: "春", systemPrompt: "丁寧に答える", failureMessages: ["失敗しました"] });
    await repo.activate("haru", 1, "admin", now);
    expect(await repo.getProduction("haru")).toMatchObject({ version: 1 });
    await repo.importDraft(definition(2), "admin", now);
    await repo.activate("haru", 2, "admin", now);
    expect(await repo.getProduction("haru")).toMatchObject({ version: 2 });
    expect(
      await sql`select version, status from character_definitions where character_id='haru' order by version`,
    ).toEqual([
      { version: 1, status: "retired" },
      { version: 2, status: "production" },
    ]);
    expect(
      await sql`select category from audit_entries where category like 'character.%' order by created_at`,
    ).toHaveLength(4);
    const audits = await sql<
      {
        category: string;
        summary: { actor: string; characterId: string; version?: number; afterVersion?: number };
        created_at: Date;
      }[]
    >`select category, summary, created_at from audit_entries where category like 'character.%' order by created_at`;
    expect(audits.map((audit) => audit.category)).toEqual([
      "character.imported",
      "character.activated",
      "character.imported",
      "character.activated",
    ]);
    expect(audits[0]?.summary).toMatchObject({ actor: "admin", characterId: "haru", version: 1 });
    expect(audits[1]?.summary).toMatchObject({ actor: "admin", characterId: "haru", afterVersion: 1 });
    expect(audits.every((audit) => audit.created_at instanceof Date)).toBe(true);
  });

  it("rejects invalid stored production JSON", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ schemaVersion: 1 })} where character_id = 'haru' and status = 'production'`;
    await expect(repo.getProduction("haru")).rejects.toThrow();
  });

  it("rejects production JSON whose identity differs from the row", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ ...definition(1), characterId: "other" })} where character_id = 'haru' and version = 1`;
    await expect(repo.getProduction("haru")).rejects.toThrow(/identity/i);
    await expect(repo.activate("haru", 1, "admin", now)).rejects.toThrow(/identity/i);
    expect(await sql`select status from character_definitions where character_id = 'haru' and version = 1`).toEqual([
      { status: "production" },
    ]);
    expect(await sql`select category from audit_entries where category like 'character.activated'`).toHaveLength(1);
  });

  it("rejects production JSON whose version differs from the row", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await sql`update character_definitions set definition = ${sql.json({ ...definition(1), version: 9 })} where character_id = 'haru' and version = 1`;
    await expect(repo.getProduction("haru")).rejects.toThrow(/identity/i);
    await expect(repo.activate("haru", 1, "admin", now)).rejects.toThrow(/identity/i);
    expect(await sql`select status from character_definitions where character_id = 'haru' and version = 1`).toEqual([
      { status: "production" },
    ]);
    expect(await sql`select category from audit_entries where category like 'character.activated'`).toHaveLength(1);
  });

  it("serializes concurrent activation of the same character", async () => {
    const repo = new PostgresCharacterRepository(sql);
    await repo.importDraft(definition(1), "admin", now);
    await repo.activate("haru", 1, "admin", now);
    await repo.importDraft(definition(2), "admin", now);
    await repo.importDraft(definition(3), "admin", now);
    await Promise.all([
      repo.activate("haru", 2, "a", new Date(now.getTime() + 1)),
      repo.activate("haru", 3, "b", new Date(now.getTime() + 2)),
    ]);
    const audits = await sql<
      { summary: { beforeVersion: number | null; afterVersion: number } }[]
    >`select summary from audit_entries where category = 'character.activated' order by created_at, id`;
    const chain = audits
      .slice(1)
      .map((row, index) => [row.summary.beforeVersion, audits[index + 1]!.summary.afterVersion]);
    expect(chain.every(([before], index) => index === 0 || before === chain[index - 1]![1])).toBe(true);
    expect(
      new Set(
        (await sql`select version from character_definitions where character_id='haru' and status='production'`).map(
          (row) => row.version,
        ),
      ),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Implement pi model construction and the adapter**

`src/adapters/pi/pi-models.ts`:

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export function createPiModels() {
  return builtinModels();
}
```

`src/adapters/pi/pi-agent-runtime.ts`:

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, Models, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  AgentRunError,
  type AgentRuntime,
  type AgentRunRequest,
  type AgentRunResult,
} from "../../modules/models/agent-runtime.js";

const RequestSchema = z.strictObject({
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  timeoutMs: z.number().int().finite().positive().max(30000),
  systemPrompt: z.string().trim().min(1).max(20000),
  userPrompt: z.string().trim().min(1).max(20000),
});
const UsageSchema = z.strictObject({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  cacheWrite: z.number().finite().nonnegative(),
  cacheWrite1h: z.number().finite().nonnegative().optional(),
  reasoning: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative(),
  cost: z.strictObject({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }),
});
function safeErrorMessage(value: unknown): string {
  return String(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\b(bearer|token|secret|api[_ -]?key)\s+[A-Za-z0-9._~+\-/]+=*/giu, "$1 [REDACTED]")
    .slice(0, 1000);
}

export class PiAgentRuntime implements AgentRuntime {
  public constructor(private readonly models: Models) {}
  public async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const provider = typeof request?.provider === "string" ? request.provider : "";
    const modelName = typeof request?.model === "string" ? request.model : "";
    let signal: AbortSignal | undefined;
    let abort: (() => void) | undefined;
    try {
      const parsed = RequestSchema.parse(request);
      const model = this.models.getModel(parsed.provider, parsed.model) as Model<any> | undefined;
      if (!model)
        throw new AgentRunError(
          `Model not found: ${parsed.provider}/${parsed.model}`,
          parsed.provider,
          parsed.model,
          "error",
        );
      signal = AbortSignal.timeout(parsed.timeoutMs);
      const agent = new Agent({
        streamFn: this.models.streamSimple.bind(this.models),
        maxRetryDelayMs: parsed.timeoutMs,
        initialState: {
          systemPrompt: parsed.systemPrompt,
          model,
          thinkingLevel: parsed.thinkingLevel,
          tools: [],
          messages: [],
        } as any,
      });
      abort = () => agent.abort();
      signal.addEventListener("abort", abort);
      await agent.prompt(parsed.userPrompt);
      const message = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant") as any;
      if (!message || message.stopReason !== "stop") {
        const stopReason = message?.stopReason === "aborted" ? "aborted" : "error";
        throw new AgentRunError(
          message?.errorMessage === undefined
            ? "Agent did not stop normally"
            : "Provider returned an unsuccessful response",
          parsed.provider,
          parsed.model,
          stopReason,
        );
      }
      const text = (message.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("")
        .trim();
      if (!text) throw new AgentRunError("Agent returned no text", parsed.provider, parsed.model, "error");
      const usage = UsageSchema.parse(message.usage);
      if (message.provider !== parsed.provider || message.model !== parsed.model)
        throw new AgentRunError("Assistant metadata mismatch", parsed.provider, parsed.model, "error");
      if (
        message.responseModel !== undefined &&
        message.responseModel !== null &&
        typeof message.responseModel !== "string"
      )
        throw new AgentRunError("Invalid response model", parsed.provider, parsed.model, "error");
      const resultUsage: Usage = {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: usage.cost,
      };
      if (usage.cacheWrite1h !== undefined) resultUsage.cacheWrite1h = usage.cacheWrite1h;
      if (usage.reasoning !== undefined) resultUsage.reasoning = usage.reasoning;
      return {
        text,
        provider: message.provider,
        model: message.model,
        responseModel: message.responseModel ?? null,
        usage: structuredClone(resultUsage),
        stopReason: "stop",
      };
    } catch (error) {
      if (error instanceof AgentRunError)
        throw new AgentRunError(safeErrorMessage(error.message), error.provider, error.model, error.stopReason);
      throw new AgentRunError(
        safeErrorMessage(error instanceof Error ? error.message : error),
        provider,
        modelName,
        signal?.aborted ? "aborted" : "error",
      );
    } finally {
      if (signal && abort) signal.removeEventListener("abort", abort);
    }
  }
}
```

- [ ] **Step 7: Run character, pi, and PostgreSQL tests**

Task 6 quality requirements: activation takes a per-character transaction advisory lock before reading production and rejects any parsed definition whose characterId/version differs from the row primary-key columns; model route objects are strict at every level; the pi runtime validates request boundaries, normalizes setup/provider failures into contextual `AgentRunError`, removes abort listeners on every path, validates assistant provider/model/response metadata and a strict finite nonnegative `Usage` whitelist including optional `cacheWrite1h` and `reasoning` when present, extracts text blocks only, and replaces provider-supplied assistant errorMessage content with the fixed safe message `Provider returned an unsuccessful response` before every `AgentRunError` path. Tests cover unknown route keys, same-character concurrent activation/audit chaining, row/JSON identity corruption with rollback, invalid runtime requests, metadata/usage rejection including optional Usage, provider error confidentiality, and timeout-driven abort. The authoritative runtime and character repository implementations and tests are the current files `src/adapters/pi/pi-agent-runtime.ts`, `src/adapters/pi/pi-agent-runtime.test.ts`, `src/adapters/postgres/character-repository.ts`, and `spec/adapters/postgres/character-repository.spec.ts`; this section must remain synchronized with their validation, metadata, Usage, fixed provider-error, identity-integrity, and real-abort behavior.

Run: `nix develop -c pnpm test`

Expected: CharacterDefinition, pi faux provider, and character repository tests PASS.

- [ ] **Step 8: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 7: Process Mention Jobs into Audited Reply Effects

**Files:**

- Create: `src/modules/effects/effect.ts`
- Create: `src/modules/mentions/process-mention.ts`
- Create: `src/adapters/postgres/decision-effect-store.ts`
- Create: `src/modules/mentions/process-mention.test.ts`
- Create: `spec/adapters/postgres/decision-effect-store.spec.ts`

- [ ] **Step 1: Write failing mention processing tests**

`src/modules/mentions/process-mention.test.ts`:

```ts
/* oxlint-disable typescript/unbound-method */
import { describe, expect, it, vi } from "vitest";
import type { CharacterDefinition } from "../characters/character-definition.js";
import type { JobQueue } from "../jobs/job-queue.js";
import { AgentRunError, type AgentRuntime } from "../models/agent-runtime.js";
import type { Clock } from "../../shared/clock.js";
import { handleMentionFailure, processMention, type DecisionEffectStore } from "./process-mention.js";

const character: CharacterDefinition = {
  schemaVersion: 1,
  characterId: "primary",
  version: 1,
  name: "テスト",
  language: "ja",
  systemPrompt: "キャラクター",
  failureMessages: ["失敗しました。"],
};
const routes = {
  version: "route-v1",
  mentionResponseDeadlineMs: 25_000,
  mentionResponse: [
    { provider: "first", model: "m1", thinkingLevel: "off" as const, timeoutMs: 5_000 },
    { provider: "second", model: "m2", thinkingLevel: "off" as const, timeoutMs: 5_000 },
  ],
};
function store(): DecisionEffectStore {
  return {
    loadMentionEvent: vi.fn().mockResolvedValue({
      eventId: "event-1",
      guildId: "g",
      capabilityChannelId: "c",
      targetChannelId: "c",
      messageId: "m",
      actorId: "u",
      text: "@bot hi",
    }),
    startOrLoadRun: vi.fn().mockResolvedValue({ runId: "run-1", state: "running" }),
    recordModelCall: vi.fn(),
    completeWithReply: vi.fn(),
    failRunAndJob: vi.fn(),
  };
}
const job = { id: "job-1", eventId: "event-1", attempts: 1, maxAttempts: 3, leaseToken: "token" };
class MutableClock implements Clock {
  constructor(private current = new Date("2026-07-23T00:00:00.000Z")) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe("processMention", () => {
  it("falls back to the second route", async () => {
    const runtime: AgentRuntime = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new AgentRunError("down", "first", "m1", "error"))
        .mockResolvedValueOnce({
          text: "  こんにちは  ",
          provider: "second",
          model: "m2",
          responseModel: null,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        }),
    };
    const persistence = store();
    await processMention(job, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.completeWithReply)).toHaveBeenCalledWith(
      expect.objectContaining({ content: "こんにちは", fallback: false, leaseToken: "token", eventId: "event-1" }),
    );
  });
  it("records usage on validation failure and uses character fallback", async () => {
    const persistence = store();
    const runtime: AgentRuntime = {
      run: vi.fn().mockResolvedValue({
        text: " ",
        provider: "first",
        model: "m1",
        responseModel: null,
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }),
    };
    await processMention(job, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.completeWithReply)).toHaveBeenCalledWith(
      expect.objectContaining({ content: "失敗しました。", fallback: true }),
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", usage: expect.objectContaining({ input: 3 }) }),
    );
  });
  it("records every failed route before character fallback", async () => {
    const persistence = store();
    const runtime: AgentRuntime = { run: vi.fn().mockRejectedValue(new AgentRunError("down", "first", "m1", "error")) };
    await processMention(job, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
  });
  it("caps timeout and stops calling routes after the deadline", async () => {
    const persistence = store();
    const controllable = new MutableClock();
    const runtime: AgentRuntime = {
      run: vi.fn().mockImplementation(async (request) => {
        controllable.advance(11_000);
        return {
          text: "",
          provider: request.provider,
          model: request.model,
          responseModel: null,
          usage: null,
          stopReason: "stop",
        };
      }),
    };
    await processMention(
      job,
      character,
      {
        version: routes.version,
        mentionResponseDeadlineMs: 10_000,
        mentionResponse: [{ ...routes.mentionResponse[0]!, timeoutMs: 30_000 }, routes.mentionResponse[1]!],
      },
      runtime,
      persistence,
      controllable,
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runtime.run).mock.calls[0]![0].timeoutMs).toBe(10_000);
  });
  it("does not route to another model after persistence failure", async () => {
    const persistence = store();
    persistence.recordModelCall = vi.fn().mockRejectedValue(new Error("db down"));
    const runtime: AgentRuntime = {
      run: vi.fn().mockResolvedValue({
        text: "返事",
        provider: "first",
        model: "m1",
        responseModel: null,
        usage: null,
        stopReason: "stop",
      }),
    };
    await expect(processMention(job, character, routes, runtime, persistence, new MutableClock())).rejects.toThrow(
      "db down",
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
  });
  it("bubbles completion persistence failure without fallback", async () => {
    const persistence = store();
    persistence.completeWithReply = vi.fn().mockRejectedValue(new Error("completion down"));
    const runtime: AgentRuntime = {
      run: vi.fn().mockResolvedValue({
        text: "返事",
        provider: "first",
        model: "m1",
        responseModel: null,
        usage: null,
        stopReason: "stop",
      }),
    };
    await expect(processMention(job, character, routes, runtime, persistence, new MutableClock())).rejects.toThrow(
      "completion down",
    );
    expect(vi.mocked(runtime.run)).toHaveBeenCalledTimes(1);
  });
  it("records allowlisted error codes instead of runtime secrets", async () => {
    const persistence = store();
    const runtime: AgentRuntime = {
      run: vi.fn().mockRejectedValue(new AgentRunError("token=secret https://db/password", "p", "m", "error")),
    };
    await processMention(job, character, routes, runtime, persistence, new MutableClock());
    expect(vi.mocked(persistence.recordModelCall)).toHaveBeenCalledWith(
      expect.objectContaining({ error: "model_runtime_failed" }),
    );
  });
  it("retries transient mention failures with the injected clock", async () => {
    const queue: JobQueue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const persistence = store();
    const retryClock = new MutableClock();
    await handleMentionFailure(job, "x".repeat(3000), queue, persistence, retryClock);
    expect(vi.mocked(queue.fail)).toHaveBeenCalledWith("job-1", "token", expect.any(String), true, retryClock.now());
    expect(vi.mocked(persistence.failRunAndJob)).not.toHaveBeenCalled();
    expect(vi.mocked(queue.fail).mock.calls[0]![2]).toBe("mention_processing_failed");
  });
  it("atomically terminates the final mention failure", async () => {
    const queue: JobQueue = { claim: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const failureStore = store();
    const finalJob = { ...job, attempts: 3 };
    await handleMentionFailure(finalJob, "provider unavailable", queue, failureStore, new MutableClock());
    expect(vi.mocked(failureStore.failRunAndJob)).toHaveBeenCalledWith(
      "job-1",
      "token",
      "mention_processing_failed",
      expect.any(Date),
    );
    expect(vi.mocked(queue.fail)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run: `nix develop -c pnpm exec vitest run src/modules/mentions/process-mention.test.ts`

Expected: FAIL because mention processing does not exist.

- [ ] **Step 3: Define the reply effect contract and mention processing port**

`src/modules/effects/effect.ts`:

```ts
import { createHash } from "node:crypto";
import { z } from "zod";

export const DiscordReplyPayloadSchema = z.strictObject({
  content: z.string().trim().min(1).max(600),
  allowedMentions: z.strictObject({ parse: z.tuple([]), repliedUser: z.literal(false) }),
});
export type DiscordReplyPayload = z.infer<typeof DiscordReplyPayloadSchema>;
export type EffectState = "planned" | "executing" | "succeeded" | "failed" | "unknown";
export interface ClaimedReplyEffect {
  id: string;
  runId: string;
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  targetMessageId: string;
  content: string;
  attempts: number;
}
export interface EffectQueue {
  succeed(id: string, externalResourceId: string, now: Date): Promise<void>;
  fail(id: string, error: string, now: Date): Promise<void>;
  markUnknown(id: string, error: string, now: Date): Promise<void>;
}
export function effectNonce(effectId: string): string {
  return createHash("sha256").update(effectId).digest("base64url").slice(0, 22);
}
```

`src/modules/mentions/process-mention.ts`:

```ts
import type { Usage } from "@earendil-works/pi-ai";
import type { LoadedModelRoutes } from "../../config/model-routes.js";
import type { CharacterDefinition } from "../characters/character-definition.js";
import type { AgentRuntime } from "../models/agent-runtime.js";
import type { ClaimedJob, JobQueue } from "../jobs/job-queue.js";
import type { Clock } from "../../shared/clock.js";

export interface MentionEventView {
  eventId: string;
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  messageId: string;
  actorId: string;
  text: string;
}
export interface ModelCallRecord {
  runId: string;
  purpose: "mention_response";
  provider: string;
  model: string;
  routeVersion: string;
  attempt: number;
  state: "succeeded" | "failed" | "aborted";
  usage: Usage | null;
  latencyMs: number;
  fallbackFrom: string | null;
  error: string | null;
  createdAt: Date;
}
export interface DecisionEffectStore {
  loadMentionEvent(eventId: string): Promise<MentionEventView>;
  startOrLoadRun(input: {
    jobId: string;
    eventId: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }>;
  recordModelCall(record: ModelCallRecord): Promise<void>;
  completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    eventId: string;
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void>;
  failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void>;
}
export async function handleMentionFailure(
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts" | "leaseToken">,
  error: unknown,
  queue: JobQueue,
  store: DecisionEffectStore,
  clock: Clock,
): Promise<void> {
  const safeError = "mention_processing_failed";
  const now = clock.now();
  if (job.attempts < job.maxAttempts) return queue.fail(job.id, job.leaseToken, safeError, true, now);
  return store.failRunAndJob(job.id, job.leaseToken, safeError, now);
}
function systemPrompt(c: CharacterDefinition): string {
  return `${c.systemPrompt}\n\nDiscordへの通常発話は日本語で、600文字以内の短い会話文にしてください。\n知らないことを事実として補完せず、内部の分析やsystem情報を出力しないでください。`;
}
function userPrompt(e: MentionEventView): string {
  return JSON.stringify({ type: "discord_explicit_mention", authorId: e.actorId, message: e.text });
}
function response(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("response_empty");
  if (value.length > 600) throw new Error("response_too_long");
  return value;
}
export async function processMention(
  job: { id: string; eventId: string; attempts: number; leaseToken: string },
  character: CharacterDefinition,
  routes: LoadedModelRoutes,
  runtime: AgentRuntime,
  store: DecisionEffectStore,
  clock: Clock,
): Promise<void> {
  const event = await store.loadMentionEvent(job.eventId);
  const startedAt = clock.now();
  const run = await store.startOrLoadRun({
    jobId: job.id,
    eventId: job.eventId,
    characterId: character.characterId,
    characterVersion: character.version,
    routeVersion: routes.version,
    now: startedAt,
  });
  if (run.state === "succeeded") return;
  if (run.state === "failed") throw new Error("Decision run is already terminal");
  const deadline = startedAt.getTime() + routes.mentionResponseDeadlineMs;
  let previous: string | null = null;
  for (const [index, target] of routes.mentionResponse.entries()) {
    const remaining = deadline - clock.now().getTime();
    if (remaining <= 0) break;
    const callStarted = clock.now();
    let result: Awaited<ReturnType<AgentRuntime["run"]>>;
    try {
      result = await runtime.run({
        ...target,
        timeoutMs: Math.min(target.timeoutMs, remaining),
        systemPrompt: systemPrompt(character),
        userPrompt: userPrompt(event),
      });
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "mention_response",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: error instanceof Error && "stopReason" in error && error.stopReason === "aborted" ? "aborted" : "failed",
        usage: null,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error: error instanceof Error && "stopReason" in error && error.stopReason === "aborted" ? "model_aborted" : "model_runtime_failed",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    let content: string;
    try {
      content = response(result.text);
    } catch (error) {
      await store.recordModelCall({
        runId: run.runId,
        purpose: "mention_response",
        provider: target.provider,
        model: target.model,
        routeVersion: routes.version,
        attempt: index + 1,
        state: "failed",
        usage: result.usage,
        latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
        fallbackFrom: previous,
        error: error instanceof Error && error.message === "response_too_long" ? "response_too_long" : "response_empty",
        createdAt: clock.now(),
      });
      previous = `${target.provider}/${target.model}`;
      continue;
    }
    await store.recordModelCall({
      runId: run.runId,
      purpose: "mention_response",
      provider: result.provider,
      model: result.model,
      routeVersion: routes.version,
      attempt: index + 1,
      state: "succeeded",
      usage: result.usage,
      latencyMs: Math.max(0, clock.now().getTime() - callStarted.getTime()),
      fallbackFrom: previous,
      error: null,
      createdAt: clock.now(),
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: job.id,
      leaseToken: job.leaseToken,
      eventId: event.eventId,
      content,
      fallback: false,
      now: clock.now(),
    });
    return;
  }
  await store.completeWithReply({
    runId: run.runId,
    jobId: job.id,
    leaseToken: job.leaseToken,
    eventId: event.eventId,
    content: character.failureMessages[0]!,
    fallback: true,
    now: clock.now(),
  });
}
```

- [ ] **Step 4: Implement mention processing with bounded fallback**

Complete `src/modules/mentions/process-mention.ts` with:

The complete implementation is shown in Step 3.
- [ ] **Step 5: Implement the PostgreSQL decision/effect transaction adapter**

`src/adapters/postgres/decision-effect-store.ts`:

```ts
import type { Sql } from "postgres";
import { z } from "zod";
import { DiscordReplyPayloadSchema } from "../../modules/effects/effect.js";
import type { DecisionEffectStore, MentionEventView, ModelCallRecord } from "../../modules/mentions/process-mention.js";
import { newId } from "../../shared/ids.js";

const EventContent = z.strictObject({
  text: z.string(),
  mentionedBot: z.literal(true),
  mentionIds: z.array(z.string()),
  replyToMessageId: z.string().nullable(),
  attachments: z.array(z.unknown()),
});
const allowedErrors = new Set([
  "model_runtime_failed",
  "model_aborted",
  "response_empty",
  "response_too_long",
  "mention_processing_failed",
]);
const bounded = (value: string) => (allowedErrors.has(value) ? value : "mention_processing_failed").slice(0, 2000);
export class PostgresDecisionEffectStore implements DecisionEffectStore {
  constructor(private readonly sql: Sql) {}
  async loadMentionEvent(eventId: string): Promise<MentionEventView> {
    const rows = await this.sql<
      Array<{
        id: string;
        kind: string;
        visibility: string;
        external_event_id: string;
        guild_id: string;
        channel_id: string;
        thread_id: string | null;
        actor_id: string;
        actor_kind: string;
        content: unknown;
      }>
    >`select id, kind, visibility, external_event_id, guild_id, channel_id, thread_id, actor_id, actor_kind, content from events where id = ${eventId}`;
    const row = rows[0];
    if (
      !row ||
      row.kind !== "message.created" ||
      !["observed", "mention_only"].includes(row.visibility) ||
      row.actor_kind !== "human"
    )
      throw new Error(`Invalid mention event: ${eventId}`);
    const content = EventContent.parse(row.content);
    return {
      eventId: row.id,
      guildId: row.guild_id,
      capabilityChannelId: row.channel_id,
      targetChannelId: row.thread_id ?? row.channel_id,
      messageId: row.external_event_id,
      actorId: row.actor_id,
      text: content.text,
    };
  }
  async startOrLoadRun(input: {
    jobId: string;
    eventId: string;
    characterId: string;
    characterVersion: number;
    routeVersion: string;
    now: Date;
  }): Promise<{ runId: string; state: "running" | "succeeded" | "failed" }> {
    await this
      .sql`insert into decision_runs (id, job_id, event_id, character_id, character_version, state, model_route_version, started_at) values (${newId()}, ${input.jobId}, ${input.eventId}, ${input.characterId}, ${input.characterVersion}, 'running', ${input.routeVersion}, ${input.now}) on conflict (job_id) do nothing`;
    const rows = await this.sql<
      Array<{
        id: string;
        state: "running" | "succeeded" | "failed";
        event_id: string;
        character_id: string;
        character_version: number;
        model_route_version: string;
      }>
    >`select id, state, event_id, character_id, character_version, model_route_version from decision_runs where job_id = ${input.jobId}`;
    const row = rows[0];
    if (!row) throw new Error("Decision run disappeared");
    if (
      row.event_id !== input.eventId ||
      row.character_id !== input.characterId ||
      row.character_version !== input.characterVersion ||
      row.model_route_version !== input.routeVersion
    )
      throw new Error("Decision run metadata mismatch");
    return { runId: row.id, state: row.state };
  }
  async recordModelCall(record: ModelCallRecord): Promise<void> {
    const u = record.usage;
    await this
      .sql`insert into model_calls (id, run_id, purpose, provider, model, route_version, attempt, state, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, latency_ms, fallback_from, structured_output_failure, error, created_at) values (${newId()}, ${record.runId}, ${record.purpose}, ${record.provider}, ${record.model}, ${record.routeVersion}, ${record.attempt}, ${record.state}, ${u?.input ?? 0}, ${u?.output ?? 0}, ${u?.cacheRead ?? 0}, ${u?.cacheWrite ?? 0}, ${u?.cost?.total ?? 0}, ${record.latencyMs}, ${record.fallbackFrom}, false, ${record.error ? bounded(record.error) : null}, ${record.createdAt})`;
  }
  async completeWithReply(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    eventId: string;
    content: string;
    fallback: boolean;
    now: Date;
  }): Promise<void> {
    const payload = DiscordReplyPayloadSchema.parse({
      content: input.content,
      allowedMentions: { parse: [], repliedUser: false },
    });
    await this.sql.begin(async (tx) => {
      const canonicalJob = await tx<
        Array<{ event_id: string }>
      >`select event_id from jobs where id = ${input.jobId} for update`;
      if (!canonicalJob[0] || canonicalJob[0].event_id !== input.eventId) throw new Error("Invalid job event");
      const runs = await tx<
        Array<{ state: string; job_id: string; event_id: string }>
      >`select state, job_id, event_id from decision_runs where id = ${input.runId} for update`;
      const run = runs[0];
      if (!run || run.job_id !== input.jobId || run.event_id !== input.eventId || run.state === "failed")
        throw new Error("Invalid decision run");
      if (run.state === "succeeded") {
        const existing =
          await tx`select 1 from effects where run_id = ${input.runId} and effect_slot = 'primary_reply'`;
        if (existing.length) return;
        throw new Error("Succeeded run has no primary effect");
      }
      const jobUpdate =
        await tx`update jobs set state = 'succeeded', leased_until = null, lease_owner = null, lease_token = null, updated_at = ${input.now} where id = ${input.jobId} and event_id = ${input.eventId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} returning id`;
      if (!jobUpdate.length) throw new Error("Lease lost");
      await tx`update decision_runs set state = 'succeeded', action_kind = 'reply', reason_codes = ${tx.array(["explicit_mention", input.fallback ? "model_fallback" : "model_response"])}, finished_at = ${input.now} where id = ${input.runId}`;
      const eventRows = await tx<
        Array<{
          guild_id: string;
          channel_id: string;
          thread_id: string | null;
          external_event_id: string;
          actor_kind: string;
          kind: string;
          visibility: string;
          content: unknown;
        }>
      >`select guild_id, channel_id, thread_id, external_event_id, actor_kind, kind, visibility, content from events where id = ${input.eventId}`;
      const event = eventRows[0];
      if (
        !event ||
        event.kind !== "message.created" ||
        !["observed", "mention_only"].includes(event.visibility) ||
        event.actor_kind !== "human" ||
        !EventContent.safeParse(event.content).success
      )
        throw new Error("Invalid mention event");
      const effects = await tx<
        Array<{ id: string }>
      >`insert into effects (id, run_id, effect_slot, kind, state, guild_id, capability_channel_id, target_channel_id, target_message_id, payload, capability_decision, created_at, updated_at) values (${newId()}, ${input.runId}, 'primary_reply', 'discord.reply', 'planned', ${event.guild_id}, ${event.channel_id}, ${event.thread_id ?? event.channel_id}, ${event.external_event_id}, ${tx.json(payload)}, ${tx.json({ action: "respond_to_mention", allowed: true })}, ${input.now}, ${input.now}) returning id`;
      await tx`insert into audit_entries (id, category, event_id, job_id, run_id, effect_id, summary, created_at) values (${newId()}, 'decision.completed', ${input.eventId}, ${input.jobId}, ${input.runId}, ${effects[0]!.id}, ${tx.json({ action: "reply", fallback: input.fallback })}, ${input.now})`;
    });
  }
  async failRunAndJob(jobId: string, leaseToken: string, error: string, now: Date): Promise<void> {
    await this.sql.begin(async (tx) => {
      const lockedJobs = await tx<
        Array<{ id: string; event_id: string }>
      >`select id, event_id from jobs where id = ${jobId} for update`;
      if (!lockedJobs[0]) throw new Error("Job not found");
      const runs = await tx<
        Array<{ id: string; state: string }>
      >`select id, state from decision_runs where job_id = ${jobId} for update`;
      if (runs[0]?.state === "succeeded") throw new Error("Succeeded decision run cannot fail");
      const jobs =
        await tx`update jobs set state = 'failed', last_error = ${bounded(error)}, leased_until = null, lease_owner = null, lease_token = null, updated_at = ${now} where id = ${jobId} and state = 'running' and lease_token = ${leaseToken} and leased_until > ${now} returning id`;
      if (!jobs.length) throw new Error("Lease lost");
      const runId = runs[0]?.id ?? null;
      if (runId)
        await tx`update decision_runs set state = 'failed', error = ${bounded(error)}, finished_at = ${now} where id = ${runId} and state = 'running'`;
      await tx`insert into audit_entries (id, category, event_id, job_id, run_id, summary, created_at) values (${newId()}, 'decision.failed', null, ${jobId}, ${runId}, ${tx.json({ error: bounded(error) })}, ${now})`;
    });
  }
}
```

`spec/adapters/postgres/decision-effect-store.spec.ts`:

```ts
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";
import { PostgresDecisionEffectStore } from "../../../src/adapters/postgres/decision-effect-store.js";

let sql: Sql;
beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
});
afterAll(async () => sql.end());
beforeEach(async () => {
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
});
async function fixture(
  leaseToken = "00000000-0000-4000-8000-000000000001",
  leasedUntil = new Date("2026-07-23T00:01:00Z"),
) {
  const now = new Date("2026-07-23T00:00:00Z");
  const eventId = "00000000-0000-4000-8000-000000000020";
  const jobId = "00000000-0000-4000-8000-000000000021";
  await sql`insert into events (id, schema_version, source, external_event_id, external_version, kind, visibility, guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at) values (${eventId}, 1, 'discord', 'message-20', '0', 'message.created', 'mention_only', 'g', 'c', 'u', 'human', ${now}, ${now}, ${sql.json({ text: "@bot hi", mentionedBot: true, mentionIds: ["bot"], replyToMessageId: null, attachments: [] })}, ${new Date("2026-08-22T00:00:00Z")})`;
  await sql`insert into jobs (id, kind, event_id, state, available_at, leased_until, lease_owner, lease_token, attempts, max_attempts, created_at, updated_at) values (${jobId}, 'mention_response', ${eventId}, 'running', ${now}, ${leasedUntil}, 'worker', ${leaseToken}, 1, 3, ${now}, ${now})`;
  return { now, eventId, jobId, leaseToken };
}
describe("PostgresDecisionEffectStore", () => {
  it("completes idempotently with one effect/audit and clears the lease", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const input = {
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    };
    await store.completeWithReply(input);
    await store.completeWithReply(input);
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "succeeded", lease_token: null, leased_until: null },
    ]);
    await expect(sql`select count(*)::int as count from effects where run_id = ${run.runId}`).resolves.toEqual([
      { count: 1 },
    ]);
    await expect(sql`select count(*)::int as count from audit_entries where run_id = ${run.runId}`).resolves.toEqual([
      { count: 1 },
    ]);
  });
  it("uses canonical parent capability and thread target fields", async () => {
    const f = await fixture();
    await sql`update events set channel_id = 'parent', thread_id = 'thread-1' where id = ${f.eventId}`;
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    });
    await expect(
      sql`select guild_id, capability_channel_id, target_channel_id, target_message_id from effects`,
    ).resolves.toEqual([
      {
        guild_id: "g",
        capability_channel_id: "parent",
        target_channel_id: "thread-1",
        target_message_id: "message-20",
      },
    ]);
  });
  it("loads explicit mentions from observed visibility", async () => {
    const f = await fixture();
    await sql`update events set visibility = 'observed' where id = ${f.eventId}`;
    await expect(new PostgresDecisionEffectStore(sql).loadMentionEvent(f.eventId)).resolves.toMatchObject({
      eventId: f.eventId,
      text: "@bot hi",
    });
  });
  it("rejects every persisted run metadata mismatch", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    for (const input of [
      { eventId: "00000000-0000-4000-8000-000000000099" },
      { characterId: "other" },
      { characterVersion: 2 },
      { routeVersion: "route-v2" },
    ]) {
      await expect(
        store.startOrLoadRun({
          jobId: f.jobId,
          eventId: input.eventId ?? f.eventId,
          characterId: input.characterId ?? "primary",
          characterVersion: input.characterVersion ?? 1,
          routeVersion: input.routeVersion ?? "route-v1",
          now: f.now,
        }),
      ).rejects.toThrow(/metadata mismatch/i);
    }
  });
  it("rolls back completion when the lease token is stale or expired", async () => {
    for (const [token, until] of [
      ["00000000-0000-4000-8000-000000000002", new Date("2026-07-23T00:01:00Z")],
      ["00000000-0000-4000-8000-000000000001", new Date("2026-07-22T00:00:00Z")],
    ] as const) {
      const f = await fixture("00000000-0000-4000-8000-000000000001", until);
      const store = new PostgresDecisionEffectStore(sql);
      const run = await store.startOrLoadRun({
        jobId: f.jobId,
        eventId: f.eventId,
        characterId: "primary",
        characterVersion: 1,
        routeVersion: "route-v1",
        now: f.now,
      });
      await expect(
        store.completeWithReply({
          runId: run.runId,
          jobId: f.jobId,
          leaseToken: token,
          eventId: f.eventId,
          content: "返事",
          fallback: false,
          now: f.now,
        }),
      ).rejects.toThrow(/lease lost/i);
      await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
        { state: "running", lease_token: f.leaseToken, leased_until: until },
      ]);
      await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([
        { state: "running" },
      ]);
      await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
      await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
      await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events cascade`;
    }
  });
  it("atomically fails a leased job and its running decision", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await store.failRunAndJob(f.jobId, f.leaseToken, "x".repeat(3000), f.now);
    await expect(
      sql`select state, lease_token, leased_until, length(last_error) as error_length from jobs where id = ${f.jobId}`,
    ).resolves.toEqual([{ state: "failed", lease_token: null, leased_until: null, error_length: 25 }]);
    await expect(
      sql`select state, length(error) as error_length from decision_runs where id = ${run.runId}`,
    ).resolves.toEqual([{ state: "failed", error_length: 25 }]);
    await expect(sql`select category, run_id from audit_entries where job_id = ${f.jobId}`).resolves.toEqual([
      { category: "decision.failed", run_id: run.runId },
    ]);
  });
  it("rolls back terminal failure on a wrong token", async () => {
    const f = await fixture();
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await expect(store.failRunAndJob(f.jobId, "00000000-0000-4000-8000-000000000002", "bad", f.now)).rejects.toThrow(
      /lease lost/i,
    );
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "running", lease_token: f.leaseToken, leased_until: new Date("2026-07-23T00:01:00Z") },
    ]);
    await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([{ state: "running" }]);
    await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
    await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
  });
  it("rolls back terminal failure on an expired lease", async () => {
    const f = await fixture("00000000-0000-4000-8000-000000000001", new Date("2026-07-22T00:00:00Z"));
    const store = new PostgresDecisionEffectStore(sql);
    const run = await store.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    await expect(store.failRunAndJob(f.jobId, f.leaseToken, "expired", f.now)).rejects.toThrow(/lease lost/i);
    await expect(sql`select state, lease_token, leased_until from jobs where id = ${f.jobId}`).resolves.toEqual([
      { state: "running", lease_token: f.leaseToken, leased_until: new Date("2026-07-22T00:00:00Z") },
    ]);
    await expect(sql`select state from decision_runs where id = ${run.runId}`).resolves.toEqual([{ state: "running" }]);
    await expect(sql`select count(*)::int as count from effects`).resolves.toEqual([{ count: 0 }]);
    await expect(sql`select count(*)::int as count from audit_entries`).resolves.toEqual([{ count: 0 }]);
  });
  it("settles concurrent completion and final failure without deadlock", async () => {
    const f = await fixture();
    const completion = new PostgresDecisionEffectStore(sql);
    const failure = new PostgresDecisionEffectStore(sql);
    const run = await completion.startOrLoadRun({
      jobId: f.jobId,
      eventId: f.eventId,
      characterId: "primary",
      characterVersion: 1,
      routeVersion: "route-v1",
      now: f.now,
    });
    const complete = completion.completeWithReply({
      runId: run.runId,
      jobId: f.jobId,
      leaseToken: f.leaseToken,
      eventId: f.eventId,
      content: "返事",
      fallback: false,
      now: f.now,
    });
    const fail = failure.failRunAndJob(f.jobId, f.leaseToken, "race", f.now);
    const result = await Promise.race([
      Promise.allSettled([complete, fail]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock")), 2000)),
    ]);
    expect(result).toHaveLength(2);
    const rows = await sql<
      Array<{ job_state: string; run_state: string; effects: number; completed: number; failed: number }>
    >`select (select state from jobs where id = ${f.jobId}) as job_state, (select state from decision_runs where id = ${run.runId}) as run_state, (select count(*)::int from effects where run_id = ${run.runId}) as effects, (select count(*)::int from audit_entries where category = 'decision.completed') as completed, (select count(*)::int from audit_entries where category = 'decision.failed') as failed`;
    expect(rows[0]!.effects + rows[0]!.failed).toBe(1);
    expect(
      rows[0]!.job_state === "succeeded"
        ? rows[0]!.run_state === "succeeded" && rows[0]!.completed === 1
        : rows[0]!.job_state === "failed" && rows[0]!.run_state === "failed" && rows[0]!.failed === 1,
    ).toBe(true);
  });
});
```

- [ ] **Step 6: Run mention and PostgreSQL specifications**

Run: `nix develop -c pnpm test`

Expected: fallback routing, fallback message, atomic run/effect/job completion, and duplicate completion tests PASS.

- [ ] **Step 7: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 8: Execute Discord Reply Effects Idempotently

**Files:**

- Create: `src/adapters/postgres/effect-queue.ts`
- Create: `src/adapters/discord/discord-effect-executor.ts`
- Create: `src/modules/effects/effect.test.ts`
- Create: `spec/adapters/postgres/effect-queue.spec.ts`

- [ ] **Step 1: Write failing effect claim and execution tests**

`src/modules/effects/effect.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DiscordEffectExecutor } from "../../adapters/discord/discord-effect-executor.js";
import { effectNonce, type ClaimedReplyEffect } from "./effect.js";
import type { Clock } from "../../shared/clock.js";

const effect: ClaimedReplyEffect = {
  id: "effect-1",
  runId: "run-1",
  guildId: "guild-1",
  capabilityChannelId: "cap-1",
  targetChannelId: "target-1",
  targetMessageId: "message-1",
  content: "hello",
  attempts: 1,
};

describe("DiscordEffectExecutor", () => {
  it("replies to the exact target with a nonce and succeeds", async () => {
    const reply = vi.fn().mockResolvedValue({ id: "discord-1" });
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor({ reply }, queue).execute(effect, { now: () => new Date("2026-01-01T00:00:00Z") });
     expect(reply).toHaveBeenCalledWith({
       guildId: "guild-1",
      channelId: "target-1",
      messageId: "message-1",
      content: "hello",
      nonce: effectNonce("effect-1"),
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(queue.succeed).toHaveBeenCalledWith("effect-1", "discord-1", expect.any(Date));
    expect(queue.fail).not.toHaveBeenCalled();
    expect(queue.markUnknown).not.toHaveBeenCalled();
  });

  it("fails definitive Discord REST errors without marking unknown", async () => {
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    const error = Object.assign(new Error("bad request"), { status: 400 });
    await new DiscordEffectExecutor({ reply: vi.fn().mockRejectedValue(error) }, queue).execute(effect, {
      now: () => new Date(),
    });
    expect(queue.fail).toHaveBeenCalledWith("effect-1", "discord_request_failed", expect.any(Date));
    expect(queue.markUnknown).not.toHaveBeenCalled();
  });

  it("marks network errors unknown without failing", async () => {
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor({ reply: vi.fn().mockRejectedValue(new Error("secret timeout")) }, queue).execute(
      effect,
      { now: () => new Date() },
    );
    expect(queue.markUnknown).toHaveBeenCalledWith("effect-1", "discord_delivery_unknown", expect.any(Date));
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("uses completion time and propagates transition failures", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const clock: Clock = { now: () => current };
    const queue = { succeed: vi.fn().mockRejectedValue(new Error("db")), fail: vi.fn(), markUnknown: vi.fn() };
    const reply = vi.fn().mockImplementation(async () => {
      current = new Date("2026-01-01T00:00:01Z");
      return { id: "d" };
    });
    await new DiscordEffectExecutor({ reply }, queue).execute(effect, clock);
    expect(queue.markUnknown).toHaveBeenCalledWith(
      "effect-1",
      "effect_state_persistence_failed",
      new Date("2026-01-01T00:00:01Z"),
    );
    queue.markUnknown.mockRejectedValue(new Error("db2"));
    await expect(new DiscordEffectExecutor({ reply }, queue).execute(effect, clock)).rejects.toBeInstanceOf(
      AggregateError,
    );
  });
});
```

`spec/adapters/postgres/effect-queue.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { PostgresEffectQueue } from "../../../src/adapters/postgres/effect-queue.js";
import { runMigrations } from "../../../src/adapters/postgres/migrations.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgresEffectQueue", () => {
  it("claims one planned effect concurrently and persists its transitions", async () => {
    const sql = createPostgresClient(url!);
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`truncate audit_entries, effects, decision_runs, jobs, events cascade`;
    const now = new Date("2026-01-01T00:00:00Z");
    const eventId = "00000000-0000-0000-0000-000000000001";
    const runId = "00000000-0000-0000-0000-000000000002";
    const effectId = "00000000-0000-0000-0000-000000000003";
    await sql`insert into events (id,schema_version,source,external_event_id,external_version,kind,visibility,guild_id,channel_id,actor_id,actor_kind,occurred_at,received_at,content,expires_at) values (${eventId},1,'discord','m','1','message.created','observed','g','c','a','human',${now},${now},${sql.json({})},${now})`;
    await sql`insert into jobs (id,kind,event_id,state,available_at,created_at,updated_at) values ('00000000-0000-0000-0000-000000000004','mention_response',${eventId},'queued',${now},${now},${now})`;
    await sql`insert into decision_runs (id,job_id,event_id,character_id,character_version,model_route_version,state,started_at) values (${runId},'00000000-0000-0000-0000-000000000004',${eventId},'c',1,'r','succeeded',${now})`;
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${effectId},${runId},'primary_reply','discord.reply','planned','g','cap','target','message',${sql.json({ content: "hello", allowedMentions: { parse: [], repliedUser: false } })},${sql.json({})},${now},${now})`;
    const [a, b] = await Promise.all([
      new PostgresEffectQueue(sql).claim("a", now),
      new PostgresEffectQueue(sql).claim("b", now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const plannedInspection = await new PostgresEffectQueue(sql).inspect(effectId);
    expect(plannedInspection).toMatchObject({
      id: effectId,
      runId,
      effectSlot: "primary_reply",
      kind: "discord.reply",
      state: "executing",
      guildId: "g",
      capabilityChannelId: "cap",
      targetChannelId: "target",
      targetMessageId: "message",
      content: "hello",
      allowedMentions: { parse: [], repliedUser: false },
      externalResourceId: null,
      executorId: expect.stringMatching(/^[ab]$/),
      attempts: 1,
      error: null,
    });
    expect(plannedInspection.createdAt).toEqual(now);
    expect(plannedInspection.updatedAt).toEqual(now);
    await new PostgresEffectQueue(sql).succeed(effectId, "external", now);
    expect(await sql`select state, external_resource_id, attempts from effects where id=${effectId}`).toEqual([
      { state: "succeeded", external_resource_id: "external", attempts: 1 },
    ]);
    expect(await sql`select category from audit_entries where effect_id=${effectId}`).toEqual([
      { category: "effect.succeeded" },
    ]);
    await sql`update effects set payload=${sql.json({ content: "", allowedMentions: { parse: [], repliedUser: false } })} where id=${effectId}`;
    await expect(new PostgresEffectQueue(sql).inspect(effectId)).rejects.toThrow();
    const poisonId = "00000000-0000-0000-0000-000000000005";
    const validId = "00000000-0000-0000-0000-000000000006";
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${poisonId},${runId},'poison','discord.reply','planned','g','cap','target','poison',${sql.json({ content: "" })},${sql.json({})},${new Date(now.getTime() + 1)},${now})`;
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${validId},${runId},'valid','discord.reply','planned','g','cap','target','valid',${sql.json({ content: "next", allowedMentions: { parse: [], repliedUser: false } })},${sql.json({})},${new Date(now.getTime() + 2)},${now})`;
    await expect(new PostgresEffectQueue(sql).claim("poison", now)).resolves.toBeNull();
    expect(await sql`select state,error from effects where id=${poisonId}`).toEqual([
      { state: "failed", error: "invalid_effect_payload" },
    ]);
    expect(
      await sql`select category,summary->>'error' as error from audit_entries where effect_id=${poisonId}`,
    ).toEqual([{ category: "effect.failed", error: "invalid_effect_payload" }]);
    await expect(new PostgresEffectQueue(sql).claim("valid", now)).resolves.toMatchObject({
      id: validId,
      content: "next",
    });
    await sql.end({ timeout: 1 });
  });

  it("enforces mode gates, recovery, reconciliation, and invalid transitions", async () => {
    const sql = createPostgresClient(url!);
    await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
      actor: "test-bootstrap",
      backupConfirmedAt: new Date(),
    });
    await sql`truncate audit_entries, effects, decision_runs, jobs, events cascade`;
    const now = new Date("2026-01-01T00:00:00Z");
    const eventId = "00000000-0000-0000-0000-000000000011";
    const jobId = "00000000-0000-0000-0000-000000000012";
    const runId = "00000000-0000-0000-0000-000000000013";
    const effectId = "00000000-0000-0000-0000-000000000014";
    await sql`insert into events (id,schema_version,source,external_event_id,external_version,kind,visibility,guild_id,channel_id,actor_id,actor_kind,occurred_at,received_at,content,expires_at) values (${eventId},1,'discord','m2','1','message.created','observed','g2','c2','a2','human',${now},${now},${sql.json({})},${now})`;
    await sql`insert into jobs (id,kind,event_id,state,available_at,created_at,updated_at) values (${jobId},'mention_response',${eventId},'queued',${now},${now},${now})`;
    await sql`insert into decision_runs (id,job_id,event_id,character_id,character_version,model_route_version,state,started_at) values (${runId},${jobId},${eventId},'c',1,'r','succeeded',${now})`;
    const payload = sql.json({ content: "hello", allowedMentions: { parse: [], repliedUser: false } });
    await sql`insert into effects (id,run_id,effect_slot,kind,state,guild_id,capability_channel_id,target_channel_id,target_message_id,payload,capability_decision,created_at,updated_at) values (${effectId},${runId},'primary_reply','discord.reply','planned','g2','cap2','target2','message2',${payload},${sql.json({})},${now},${now})`;
    await sql`update system_state set mode='stopped' where singleton`;
    await expect(new PostgresEffectQueue(sql).claim("stopped", now)).resolves.toBeNull();
    await sql`update system_state set mode='draining' where singleton`;
    const claimed = await new PostgresEffectQueue(sql).claim("draining", now);
    expect(claimed).toMatchObject({
      id: effectId,
      targetChannelId: "target2",
      targetMessageId: "message2",
      content: "hello",
      attempts: 1,
    });
    expect(await sql`select executor_id, attempts from effects where id=${effectId}`).toEqual([
      { executor_id: "draining", attempts: 1 },
    ]);
    await expect(new PostgresEffectQueue(sql).succeed(effectId, "discord-2", now)).resolves.toBeUndefined();
    await expect(new PostgresEffectQueue(sql).succeed(effectId, "discord-2", now)).rejects.toThrow(
      "Invalid effect transition",
    );
    expect(
      await sql`select category, summary->>'externalResourceId' as external_id from audit_entries where effect_id=${effectId}`,
    ).toEqual([{ category: "effect.succeeded", external_id: "discord-2" }]);

    await sql`update effects set state='executing' where id=${effectId}`;
    await new PostgresEffectQueue(sql).fail(effectId, "rest failed", now);
    expect(await sql`select state, error from effects where id=${effectId}`).toEqual([
      { state: "failed", error: "effect_execution_failed" },
    ]);
    expect(
      await sql`select category from audit_entries where effect_id=${effectId} order by created_at, id`,
    ).toHaveLength(2);

    await sql`update effects set state='executing' where id=${effectId}`;
    await new PostgresEffectQueue(sql).markUnknown(effectId, "network timeout", now);
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({ state: "unknown", externalResourceId: null });
    await expect(
      new PostgresEffectQueue(sql).reconcileUnknown(effectId, "succeeded", null, "", "reason", now),
    ).rejects.toThrow("Actor is required");
    await new PostgresEffectQueue(sql).reconcileUnknown(
      effectId,
      "succeeded",
      "discord-3",
      "operator",
      "checked Discord",
      now,
    );
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({
      state: "succeeded",
      externalResourceId: "discord-3",
    });

    await sql`update effects set state='executing' where id=${effectId}`;
    expect(await new PostgresEffectQueue(sql).recoverExecutingAsUnknown(now)).toBe(1);
    expect(await new PostgresEffectQueue(sql).get(effectId)).toEqual({
      state: "unknown",
      externalResourceId: "discord-3",
    });
    expect(
      await sql`select count(*)::int as count from audit_entries where category='effect.unknown' and effect_id=${effectId}`,
    ).toEqual([{ count: 2 }]);
    await sql.end({ timeout: 1 });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `nix develop -c pnpm test`

Expected: FAIL because effect queue and executor do not exist.

- [ ] **Step 3: Implement the effect queue state machine**

`src/adapters/postgres/effect-queue.ts`:

```ts
import type { Sql } from "postgres";
import { DiscordReplyPayloadSchema, type ClaimedReplyEffect, type EffectState } from "../../modules/effects/effect.js";
import { newId } from "../../shared/ids.js";

const bounded = (value: string) => value.slice(0, 2000);
const safeCodes = new Set([
  "discord_request_failed",
  "discord_delivery_unknown",
  "effect_state_persistence_failed",
  "invalid_effect_payload",
  "capability_revoked",
  "executor_restart_recovery",
]);
const safeCode = (value: string) => (safeCodes.has(value) ? value : "effect_execution_failed");
const date = (value: Date, name: string) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid date`);
};
const actor = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required`);
};
export interface EffectInspection {
  id: string;
  runId: string;
  effectSlot: string;
  kind: "discord.reply";
  state: EffectState;
  guildId: string;
  capabilityChannelId: string;
  targetChannelId: string;
  targetMessageId: string;
  content: string;
  allowedMentions: { parse: []; repliedUser: false };
  externalResourceId: string | null;
  executorId: string | null;
  attempts: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  capabilityDecision: Record<string, unknown>;
}

export class PostgresEffectQueue {
  public constructor(private readonly sql: Sql) {}
  public async claim(workerId: string, now: Date): Promise<ClaimedReplyEffect | null> {
    actor(workerId, "Worker ID");
    date(now, "now");
    return this.sql.begin(async (tx) => {
      const mode = await tx<{ mode: string }[]>`select mode from system_state where singleton for share`;
      if (!mode[0]) throw new Error("System state singleton is missing");
      if (mode[0].mode === "stopped") return null;
      const rows = await tx<
        (ClaimedReplyEffect & { payload: unknown })[]
      >`with candidate as (select id from effects where state='planned' order by created_at for update skip locked limit 1) update effects e set state='executing', executor_id=${workerId}, attempts=e.attempts+1, updated_at=${now} from candidate c where e.id=c.id returning e.id, e.run_id as "runId", e.guild_id as "guildId", e.capability_channel_id as "capabilityChannelId", e.target_channel_id as "targetChannelId", e.target_message_id as "targetMessageId", e.attempts, e.payload`;
      const row = rows[0];
      if (!row) return null;
      try {
        const payload = DiscordReplyPayloadSchema.parse(row.payload);
        return { ...row, content: payload.content };
      } catch {
        await tx`update effects set state='failed', error='invalid_effect_payload', updated_at=${now} where id=${row.id} and state='executing'`;
        await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},'effect.failed',${row.runId},${row.id},${tx.json({ error: "invalid_effect_payload" })},${now})`;
        return null;
      }
    });
  }
  private async transition(
    id: string,
    expected: EffectState,
    state: EffectState,
    now: Date,
    error: string | null,
    externalResourceId: string | null,
    category: string,
    summary: Record<string, string | null>,
  ): Promise<void> {
    date(now, "now");
    await this.sql.begin(async (tx) => {
      const rows = await tx<
        { run_id: string }[]
      >`update effects set state=${state}, error=${error ? bounded(safeCode(error)) : null}, external_resource_id=${externalResourceId}, updated_at=${now} where id=${id} and state=${expected} returning run_id`;
      if (!rows[0]) throw new Error(`Invalid effect transition: ${expected} -> ${state}`);
      await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},${category},${rows[0].run_id},${id},${tx.json(summary)},${now})`;
    });
  }
  public succeed(id: string, externalResourceId: string, now: Date) {
    actor(externalResourceId, "External resource ID");
    return this.transition(id, "executing", "succeeded", now, null, externalResourceId, "effect.succeeded", {
      externalResourceId,
    });
  }
  public fail(id: string, error: string, now: Date) {
    return this.transition(id, "executing", "failed", now, error, null, "effect.failed", { error: safeCode(error) });
  }
  public markUnknown(id: string, error: string, now: Date) {
    return this.transition(id, "executing", "unknown", now, error, null, "effect.unknown", { error: safeCode(error) });
  }
  public async recoverExecutingAsUnknown(now: Date): Promise<number> {
    date(now, "now");
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        { id: string; run_id: string }[]
      >`update effects set state='unknown', error='executor_restart_recovery', updated_at=${now} where state='executing' returning id, run_id`;
      for (const row of rows)
        await tx`insert into audit_entries (id,category,run_id,effect_id,summary,created_at) values (${newId()},'effect.unknown',${row.run_id},${row.id},${tx.json({ error: "executor_restart_recovery" })},${now})`;
      return rows.length;
    });
  }
  public async get(id: string): Promise<{ state: EffectState; externalResourceId: string | null }> {
    const rows = await this.sql<
      { state: EffectState; externalResourceId: string | null }[]
    >`select state, external_resource_id as "externalResourceId" from effects where id=${id}`;
    if (!rows[0]) throw new Error("Effect not found");
    return rows[0];
  }
  public async inspect(id: string): Promise<EffectInspection> {
    const rows = await this.sql<
      {
        id: string;
        runId: string;
        effectSlot: string;
        kind: string;
        state: EffectState;
        guildId: string;
        capabilityChannelId: string;
        targetChannelId: string;
        targetMessageId: string;
        externalResourceId: string | null;
        executorId: string | null;
        attempts: number;
        error: string | null;
        createdAt: Date;
        updatedAt: Date;
        payload: unknown;
        capabilityDecision: unknown;
      }[]
    >`select id,run_id as "runId",effect_slot as "effectSlot",kind,state,guild_id as "guildId",capability_channel_id as "capabilityChannelId",target_channel_id as "targetChannelId",target_message_id as "targetMessageId",external_resource_id as "externalResourceId",executor_id as "executorId",attempts,error,created_at as "createdAt",updated_at as "updatedAt",payload,capability_decision as "capabilityDecision" from effects where id=${id}`;
    if (!rows[0]) throw new Error("Effect not found");
    const row = rows[0];
    if (row.kind !== "discord.reply") throw new Error(`Unsupported effect kind: ${row.kind}`);
    const payload = DiscordReplyPayloadSchema.parse(row.payload);
    if (
      typeof row.capabilityDecision !== "object" ||
      row.capabilityDecision === null ||
      Array.isArray(row.capabilityDecision)
    )
      throw new Error("Invalid capability decision");
    return {
      ...row,
      kind: "discord.reply",
      content: payload.content,
      allowedMentions: payload.allowedMentions,
      capabilityDecision: row.capabilityDecision as Record<string, unknown>,
    };
  }
  public async reconcileUnknown(
    id: string,
    state: "succeeded" | "failed",
    externalResourceId: string | null,
    actorName: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    actor(actorName, "Actor");
    actor(reason, "Reason");
    date(now, "now");
    if (state === "succeeded") actor(externalResourceId ?? "", "External resource ID");
    if (state === "failed" && externalResourceId !== null)
      throw new Error("Failed effect cannot have external resource ID");
    await this.transition(
      id,
      "unknown",
      state,
      now,
      state === "failed" ? reason : null,
      externalResourceId,
      "effect.reconciled",
      { actor: actorName, reason, externalResourceId },
    );
  }
}
```

- [ ] **Step 4: Implement the Discord executor boundary**

`src/adapters/discord/discord-effect-executor.ts`:

```ts
import type { ClaimedReplyEffect, EffectQueue } from "../../modules/effects/effect.js";
import type { Clock } from "../../shared/clock.js";
import { effectNonce } from "../../modules/effects/effect.js";

export interface DiscordMessenger {
  reply(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    content: string;
    nonce: string;
    enforceNonce: true;
    allowedMentions: { parse: []; repliedUser: false };
  }): Promise<{ id: string }>;
}

export class DiscordRequestRejectedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordRequestRejectedError";
  }
}

export class DiscordEffectExecutor {
  public constructor(
    private readonly messenger: DiscordMessenger,
    private readonly queue: EffectQueue,
  ) {}

  public async execute(effect: ClaimedReplyEffect, clock: Clock): Promise<void> {
    let result: { id: string };
    try {
      result = await this.messenger.reply({
        channelId: effect.targetChannelId,
        guildId: effect.guildId,
        messageId: effect.targetMessageId,
        content: effect.content,
        nonce: effectNonce(effect.id),
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 0;
      if (error instanceof DiscordRequestRejectedError || (status >= 400 && status <= 499)) {
        await this.queue.fail(effect.id, "discord_request_failed", clock.now());
      } else {
        await this.queue.markUnknown(effect.id, "discord_delivery_unknown", clock.now());
      }
      return;
    }
    try {
      await this.queue.succeed(effect.id, result.id, clock.now());
    } catch (transitionError) {
      try {
        await this.queue.markUnknown(effect.id, "effect_state_persistence_failed", clock.now());
      } catch (unknownError) {
        throw new AggregateError([transitionError, unknownError], "Effect state persistence failed");
      }
    }
  }
}
```

- [ ] **Step 5: Run effect tests**

Run: `nix develop -c pnpm test`

Expected: nonce, concurrent claim, and startup recovery tests PASS.

- [ ] **Step 6: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 9: Connect Discord Message Events and Reply Delivery

**Files:**

- Create: `src/adapters/discord/message-snapshot.ts`
- Create: `src/adapters/discord/discord-client.ts`
- Create: `src/adapters/discord/discord-client.test.ts`
- Create: `src/adapters/discord/channel-command.ts`
- Create: `src/adapters/discord/message-snapshot.test.ts`
- Create: `src/adapters/discord/channel-command.test.ts`

- [ ] **Step 1: Write failing Discord mapping tests**

`src/adapters/discord/message-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toDiscordMessageInput } from "./message-snapshot.js";

describe("toDiscordMessageInput", () => {
  it("maps a guild thread message without leaking discord.js types", () => {
    const result = toDiscordMessageInput(
      {
        id: "message-1",
        guildId: "guild-1",
        channelId: "thread-1",
        parentChannelId: "channel-1",
        isThread: true,
        authorId: "user-1",
        authorIsBot: false,
        createdTimestamp: 1_774_742_400_000,
        content: "<@bot-1> こんにちは",
        mentionedUserIds: ["bot-1"],
        replyToMessageId: null,
        attachments: [],
      },
      "bot-1",
    );
    expect(result).toMatchObject({
      externalEventId: "message-1",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      actorKind: "human",
      mentionedBot: true,
    });
  });

  it("rejects DMs and messages without a thread parent", () => {
    expect(() =>
      toDiscordMessageInput(
        {
          id: "dm",
          guildId: null,
          channelId: "dm-channel",
          parentChannelId: null,
          isThread: false,
          authorId: "u",
          authorIsBot: false,
          createdTimestamp: 0,
          content: "hi",
          mentionedUserIds: [],
          replyToMessageId: null,
          attachments: [],
        },
        "bot",
      ),
    ).toThrow("DM events are outside MVP scope");
  });
});
```

- [ ] **Step 2: Run the mapping test and verify it fails**

Run: `nix develop -c pnpm exec vitest run src/adapters/discord/message-snapshot.test.ts`

Expected: FAIL because the adapter DTO and mapper do not exist.

- [ ] **Step 3: Implement a Discord-only snapshot DTO and mapper**

`src/adapters/discord/message-snapshot.ts`:

```ts
import type { DiscordMessageInput } from "../../modules/events/canonical-event.js";

export interface DiscordMessageSnapshot {
  id: string;
  guildId: string | null;
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
  authorId: string;
  authorIsBot: boolean;
  createdTimestamp: number;
  content: string;
  mentionedUserIds: string[];
  replyToMessageId: string | null;
  attachments: Array<{ id: string; name: string; contentType: string | null; url: string; size: number }>;
}

export function toDiscordMessageInput(snapshot: DiscordMessageSnapshot, botUserId: string): DiscordMessageInput {
  if (!snapshot.guildId) throw new Error("DM events are outside MVP scope");
  if (!snapshot.id.trim() || !snapshot.channelId.trim() || !snapshot.authorId.trim() || !botUserId.trim()) throw new Error("Critical Discord IDs are required");
  if (snapshot.isThread && !snapshot.parentChannelId) throw new Error("Thread message has no parent channel");
  if (!Number.isFinite(new Date(snapshot.createdTimestamp).getTime())) throw new Error("occurredAt must be a valid timestamp");
  return {
    externalEventId: snapshot.id,
    externalVersion: "0",
    guildId: snapshot.guildId,
    channelId: snapshot.isThread ? snapshot.parentChannelId! : snapshot.channelId,
    threadId: snapshot.isThread ? snapshot.channelId : null,
    actorId: snapshot.authorId,
    actorKind: snapshot.authorIsBot ? "bot" : "human",
    occurredAt: new Date(snapshot.createdTimestamp),
    content: snapshot.content,
    mentionedBot: snapshot.mentionedUserIds.includes(botUserId),
    mentionIds: [...snapshot.mentionedUserIds],
    replyToMessageId: snapshot.replyToMessageId,
    attachments: snapshot.attachments.map((attachment) => ({ ...attachment })),
  };
}
```

- [ ] **Step 4: Implement the discord.js snapshot and messenger adapter**

`src/adapters/discord/discord-client.ts`:

```ts
import type { Client, Message } from "discord.js";
import { DiscordRequestRejectedError, type DiscordMessenger } from "./discord-effect-executor.js";
import type { DiscordMessageSnapshot } from "./message-snapshot.js";

export function snapshotDiscordMessage(message: Message): DiscordMessageSnapshot {
  const isThread = message.channel.isThread();
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    parentChannelId: isThread ? message.channel.parentId : null,
    isThread,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    createdTimestamp: message.createdTimestamp,
    content: message.content,
    mentionedUserIds: [...message.mentions.users.keys()],
    replyToMessageId: message.reference?.messageId ?? null,
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? "",
      contentType: attachment.contentType,
      url: attachment.url,
      size: attachment.size,
    })),
  };
}

export class DiscordClientMessenger implements DiscordMessenger {
  public constructor(
    private readonly client: Client<true>,
    private readonly expectedGuildId: string,
  ) {}

  public async reply(input: Parameters<DiscordMessenger["reply"]>[0]): Promise<{ id: string }> {
    if (input.guildId !== this.expectedGuildId) throw new DiscordRequestRejectedError("Target guild mismatch");
    let channel;
    try {
      channel = await this.client.channels.fetch(input.channelId);
    } catch (error) {
      throw new DiscordRequestRejectedError("Target channel fetch failed", { cause: error });
    }
    if (!channel) throw new DiscordRequestRejectedError("Target channel not found");
    const guildId = "guildId" in channel && typeof channel.guildId === "string" ? channel.guildId : null;
    if (!guildId) throw new DiscordRequestRejectedError("DM channels are not allowed");
    if (guildId !== this.expectedGuildId || guildId !== input.guildId)
      throw new DiscordRequestRejectedError("Target channel guild mismatch");
    if (!channel.isTextBased() || !channel.isSendable())
      throw new DiscordRequestRejectedError("Target channel is not sendable");
    let target;
    try {
      target = await channel.messages.fetch(input.messageId);
    } catch (error) {
      throw new DiscordRequestRejectedError("Target message fetch failed", { cause: error });
    }
    if (!target) throw new DiscordRequestRejectedError("Target message not found");
    const sent = await target.reply({
      content: input.content,
      nonce: input.nonce,
      enforceNonce: input.enforceNonce,
      allowedMentions: input.allowedMentions,
    });
    return { id: sent.id };
  }
}
```

- [ ] **Step 4a: Add Discord messenger regression tests**

`src/adapters/discord/discord-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DiscordClientMessenger } from "./discord-client.js";
import { DiscordEffectExecutor } from "./discord-effect-executor.js";

function client(channel: unknown) {
  return { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as never;
}

describe("DiscordClientMessenger", () => {
  it("validates guild scope, fetches exact target, and replies safely", async () => {
    const reply = vi.fn().mockResolvedValue({ id: "sent" });
    const messages = { fetch: vi.fn().mockResolvedValue({ reply }) };
    const messenger = new DiscordClientMessenger(
      client({ guildId: "g", isTextBased: () => true, isSendable: () => true, messages }),
      "g",
    );
    await expect(
      messenger.reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).resolves.toEqual({ id: "sent" });
    expect(messages.fetch).toHaveBeenCalledWith("m");
    expect(reply).toHaveBeenCalledWith({
      content: "x",
      nonce: "n",
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
    });
  });

  it.each([
    [null, "Target channel not found"],
    [{ guildId: "other", isTextBased: () => true, isSendable: () => true }, "guild"],
    [{ guildId: "g", isTextBased: () => false, isSendable: () => false }, "sendable"],
    [{ guildId: null, isTextBased: () => true, isSendable: () => true }, "DM"],
  ])("rejects unsafe channel before message fetch/send", async (channel, message) => {
    const channelFetch = vi.fn().mockResolvedValue(channel);
    await expect(
      new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g").reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toThrow(message);
    expect(channelFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an input guild before fetching the client channel", async () => {
    const channelFetch = vi.fn();
    const messenger = new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g");
    await expect(
      messenger.reply({
        guildId: "other",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toThrow("guild");
    expect(channelFetch).not.toHaveBeenCalled();
  });

  it("normalizes preflight failures so the executor marks them definitive", async () => {
    const targetReply = vi.fn();
    const messageFetch = vi.fn().mockRejectedValue(new Error("missing message"));
    const channelFetch = vi.fn().mockResolvedValue({
      guildId: "g",
      isTextBased: () => true,
      isSendable: () => true,
      messages: { fetch: messageFetch },
    });
    const queue = { succeed: vi.fn(), fail: vi.fn(), markUnknown: vi.fn() };
    await new DiscordEffectExecutor(
      new DiscordClientMessenger({ channels: { fetch: channelFetch } } as never, "g"),
      queue,
    ).execute(
      {
        id: "e",
        runId: "r",
        guildId: "g",
        capabilityChannelId: "c",
        targetChannelId: "c",
        targetMessageId: "m",
        content: "x",
        attempts: 1,
      },
      { now: () => new Date() },
    );
    expect(messageFetch).toHaveBeenCalledWith("m");
    expect(targetReply).not.toHaveBeenCalled();
    expect(queue.fail).toHaveBeenCalledWith("e", "discord_request_failed", expect.any(Date));
  });

  it("does not normalize an error raised by target.reply", async () => {
    const targetReply = vi.fn().mockRejectedValue(Object.assign(new Error("server"), { status: 500 }));
    const messenger = new DiscordClientMessenger(
      client({
        guildId: "g",
        isTextBased: () => true,
        isSendable: () => true,
        messages: { fetch: vi.fn().mockResolvedValue({ reply: targetReply }) },
      }),
      "g",
    );
    await expect(
      messenger.reply({
        guildId: "g",
        channelId: "c",
        messageId: "m",
        content: "x",
        nonce: "n",
        enforceNonce: true,
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
```

- [ ] **Step 5: Define the channel administration slash command**

`src/adapters/discord/channel-command.ts`:

```ts
import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandChannelOption,
} from "discord.js";
import type { ChannelCapabilities } from "../../modules/channels/channel-capability.js";
import type { Clock } from "../../shared/clock.js";

const channelTypes = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildPublicThread,
  ChannelType.GuildPrivateThread,
  ChannelType.GuildNewsThread,
] as const;
const channelOption = (option: SlashCommandChannelOption) =>
  option
    .setName("channel")
    .setDescription("対象チャンネル")
    .addChannelTypes(...channelTypes)
    .setRequired(true);

export const channelCommand = new SlashCommandBuilder()
  .setName("vicissitude-channel")
  .setDescription("Vicissitudeのチャンネル権限を管理します")
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName("show").setDescription("現在の権限を表示します").addChannelOption(channelOption))
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("チャンネル権限を設定します")
      .addChannelOption(channelOption)
      .addBooleanOption((o) => o.setName("observe").setDescription("イベントを観察する"))
      .addBooleanOption((o) => o.setName("mentions").setDescription("mentionへ応答する"))
      .addBooleanOption((o) => o.setName("join").setDescription("自発参加する"))
      .addBooleanOption((o) => o.setName("topics").setDescription("自発投稿する"))
      .addBooleanOption((o) => o.setName("reactions").setDescription("reactionを追加する"))
      .addBooleanOption((o) => o.setName("threads").setDescription("threadを作成する"))
      .addBooleanOption((o) => o.setName("files").setDescription("fileを共有する"))
      .addBooleanOption((o) => o.setName("links").setDescription("外部linkを共有する"))
      .addStringOption((o) =>
        o.setName("reason").setDescription("変更理由").setMinLength(1).setMaxLength(500).setRequired(true),
      ),
  );

interface Repository {
  get(guildId: string, channelId: string): Promise<ChannelCapabilities>;
  patch(
    guildId: string,
    channelId: string,
    patch: ChannelCapabilitiesPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<void>;
}

export type ChannelCapabilitiesPatch = Partial<
  Pick<
    ChannelCapabilities,
    | "observeEvents"
    | "respondToMentions"
    | "spontaneousJoin"
    | "spontaneousTopic"
    | "addReactions"
    | "createThreads"
    | "shareFiles"
    | "shareExternalLinks"
  >
>;

export async function handleChannelCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  expectedGuildId: string,
  adminUserIds: ReadonlySet<string>,
  repository: Repository,
  clock: Clock,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "DMでは使用できません。", ephemeral: true });
    return;
  }
  if (interaction.guildId !== expectedGuildId) {
    await interaction.reply({ content: "このGuildでは使用できません。", ephemeral: true });
    return;
  }
  if (!adminUserIds.has(interaction.user.id)) {
    await interaction.reply({ content: "この操作は許可されていません。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = interaction.options.getChannel("channel", true);
    const capabilityChannelId = channel.isThread() ? channel.parentId : channel.id;
    if (!capabilityChannelId) throw new Error("Thread has no parent channel");
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "set") {
      const patch: ChannelCapabilitiesPatch = {};
      const options: Array<[string, keyof ChannelCapabilitiesPatch]> = [
        ["observe", "observeEvents"],
        ["mentions", "respondToMentions"],
        ["join", "spontaneousJoin"],
        ["topics", "spontaneousTopic"],
        ["reactions", "addReactions"],
        ["threads", "createThreads"],
        ["files", "shareFiles"],
        ["links", "shareExternalLinks"],
      ];
      for (const [option, property] of options) {
        const value = interaction.options.getBoolean(option);
        if (value !== null) patch[property] = value;
      }
      const reason = interaction.options.getString("reason", true).trim();
      if (!reason) throw new Error("Reason is required");
      await repository.patch(interaction.guildId, capabilityChannelId, patch, interaction.user.id, reason, clock.now());
      await interaction.editReply({ content: "チャンネル権限を更新しました。" });
      return;
    }
    const current = await repository.get(interaction.guildId, capabilityChannelId);
    if (subcommand === "show") {
      await interaction.editReply({ content: `\`\`\`json\n${JSON.stringify(current, null, 2)}\n\`\`\`` });
      return;
    }
    if (subcommand !== "set") throw new Error(`Unsupported subcommand: ${subcommand}`);
    throw new Error(`Unsupported subcommand: ${subcommand}`);
  } catch (error) {
    try {
      await interaction.editReply({ content: "チャンネル権限の処理に失敗しました。" });
    } catch {
      // The original error is more useful to the gateway logger.
    }
    throw error;
  }
}
```

The complete implementation is shown above.

`src/adapters/discord/channel-command.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { denyAllCapabilities } from "../../modules/channels/channel-capability.js";
import { FixedClock } from "../../shared/clock.js";
import { handleChannelCommand } from "./channel-command.js";

function interaction(input: Record<string, unknown> = {}) {
  const values = input as {
    userId?: string;
    guildId?: string | null;
    subcommand?: string;
    channel?: unknown;
    booleans?: Record<string, boolean | null>;
    reason?: string;
    events?: string[];
  };
  return {
    guildId: values.guildId === undefined ? "g" : values.guildId,
    user: { id: values.userId ?? "admin" },
    options: {
      getChannel: vi.fn(() => values.channel ?? { id: "thread", parentId: "parent", isThread: () => true }),
      getSubcommand: () => values.subcommand ?? "set",
      getBoolean: (name: string) => values.booleans?.[name] ?? null,
      getString: () => values.reason ?? " change ",
    },
    deferReply: vi.fn().mockImplementation(async () => values.events?.push("defer")),
    editReply: vi.fn().mockImplementation(async () => values.events?.push("edit")),
    reply: vi.fn().mockImplementation(async () => values.events?.push("reply")),
  } as never;
}

describe("handleChannelCommand", () => {
  it("does not read for DM or non-admin", async () => {
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn() };
    await handleChannelCommand(
      interaction({ guildId: null }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    await handleChannelCommand(
      interaction({ userId: "other" }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.set).not.toHaveBeenCalled();
  });

  it("shows current parent capability and preserves omitted values", async () => {
    const current = { ...denyAllCapabilities("g", "parent"), spontaneousJoin: true };
    const repo = { get: vi.fn().mockResolvedValue(current), set: vi.fn(), patch: vi.fn() };
    await handleChannelCommand(
      interaction({ subcommand: "show" }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).toHaveBeenCalledWith("g", "parent");
  });

  it("updates every independent flag and rejects blank or orphan reasons/threads", async () => {
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn().mockResolvedValue(undefined) };
    await handleChannelCommand(
      interaction({
        channel: { id: "c", isThread: () => false },
        booleans: {
          observe: true,
          mentions: true,
          join: true,
          topics: true,
          reactions: true,
          threads: true,
          files: true,
          links: true,
        },
        reason: "reason",
      }),
      "g",
      new Set(["admin"]),
      repo,
      new FixedClock(new Date()),
    );
    expect(repo.get).not.toHaveBeenCalled();
    expect(repo.patch).toHaveBeenCalledWith(
      "g",
      "c",
      {
        observeEvents: true,
        respondToMentions: true,
        spontaneousJoin: true,
        spontaneousTopic: true,
        addReactions: true,
        createThreads: true,
        shareFiles: true,
        shareExternalLinks: true,
      },
      "admin",
      "reason",
      expect.any(Date),
    );
    await expect(
      handleChannelCommand(interaction({ reason: "  " }), "g", new Set(["admin"]), repo, new FixedClock(new Date())),
    ).rejects.toThrow("Reason is required");
    await expect(
      handleChannelCommand(
        interaction({ channel: { id: "orphan", parentId: null, isThread: () => true } }),
        "g",
        new Set(["admin"]),
        repo,
        new FixedClock(new Date()),
      ),
    ).rejects.toThrow("Thread has no parent channel");
  });

  it("rejects another guild before admin, options, or repository work", async () => {
    const events: string[] = [];
    const repo = { get: vi.fn(), set: vi.fn(), patch: vi.fn() };
    const value = interaction({ guildId: "other", events });
    await handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()));
    expect(repo.get).not.toHaveBeenCalled();
    expect((value as { options: { getChannel: ReturnType<typeof vi.fn> } }).options.getChannel).not.toHaveBeenCalled();
    expect(events).toEqual(["reply"]);
  });

  it("defers before delayed repository work and edits exactly once", async () => {
    const events: string[] = [];
    let resolve!: (value: ReturnType<typeof denyAllCapabilities>) => void;
    const repo = {
      get: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      set: vi.fn(),
      patch: vi.fn(),
    };
    const value = interaction({ events, subcommand: "show" });
    const pending = handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()));
    await vi.waitFor(() => expect(events).toEqual(["defer"]));
    resolve(denyAllCapabilities("g", "parent"));
    await pending;
    expect(events).toEqual(["defer", "edit"]);
    expect((value as { editReply: ReturnType<typeof vi.fn> }).editReply).toHaveBeenCalledTimes(1);
  });

  it("edits a generic error and rethrows without exposing the raw error", async () => {
    const events: string[] = [];
    const value = interaction({ events });
    const error = new Error("raw database secret");
    const repo = { get: vi.fn(), patch: vi.fn().mockRejectedValue(error) };
    await expect(handleChannelCommand(value, "g", new Set(["admin"]), repo, new FixedClock(new Date()))).rejects.toBe(
      error,
    );
    expect(events).toEqual(["defer", "edit"]);
    expect((value as { editReply: ReturnType<typeof vi.fn> }).editReply.mock.calls[0]?.[0].content).not.toContain(
      "raw database secret",
    );
  });
});
```

- [ ] **Step 6: Run Discord adapter tests**

Run: `nix develop -c pnpm exec vitest run src/adapters/discord`

Expected: mapper, messenger boundary, and slash command tests PASS.

- [ ] **Step 7: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 10: Add Runtime Configuration, Logging, and the Admin CLI

**Files:**

- Create: `src/config/runtime-config.ts`
- Create: `src/observability/logger.ts`
- Create: `src/modules/admin/admin-command.ts`
- Create: `src/modules/admin/admin-command.test.ts`
- Create: `src/config/runtime-config.test.ts`
- Create: `src/observability/logger.test.ts`
- Create: `src/apps/admin-cli.ts`
- Create: `src/apps/admin-cli.test.ts`

- [ ] **Step 1: Write failing configuration and command parser tests**

`src/modules/admin/admin-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAdminCommand } from "./admin-command.js";

describe("admin parser exact union", () => {
  it.each([
    [["migration", "status"], { kind: "migration.status" }],
    [
      ["migration", "apply", "--backup-confirmed-at", "2026-07-24T00:00:00Z", "--actor", "a"],
      { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-24T00:00:00Z"), actor: "a" },
    ],
    [
      ["system", "resume", "--actor", "a", "--reason", "r"],
      { kind: "system.set", mode: "running", actor: "a", reason: "r" },
    ],
    [
      ["system", "drain", "--actor", "a", "--reason", "r"],
      { kind: "system.set", mode: "draining", actor: "a", reason: "r" },
    ],
    [
      ["system", "stop", "--actor", "a", "--reason", "r"],
      { kind: "system.set", mode: "stopped", actor: "a", reason: "r" },
    ],
    [["channel", "show", "g", "c"], { kind: "channel.show", guildId: "g", channelId: "c" }],
    [
      ["channel", "set", "g", "c", "--observe", "true", "--mentions", "false", "--actor", "a", "--reason", "r"],
      {
        kind: "channel.set",
        guildId: "g",
        channelId: "c",
        observeEvents: true,
        respondToMentions: false,
        actor: "a",
        reason: "r",
      },
    ],
    [["character", "import", "x", "--actor", "a"], { kind: "character.import", path: "x", actor: "a" }],
    [
      ["character", "activate", "id", "2", "--actor", "a"],
      { kind: "character.activate", characterId: "id", version: 2, actor: "a" },
    ],
    [["effect", "inspect", "e"], { kind: "effect.inspect", effectId: "e" }],
    [
      [
        "effect",
        "reconcile",
        "e",
        "--state",
        "succeeded",
        "--external-resource-id",
        "x",
        "--actor",
        "a",
        "--reason",
        "r",
      ],
      { kind: "effect.reconcile", effectId: "e", state: "succeeded", externalResourceId: "x", actor: "a", reason: "r" },
    ],
    [
      ["effect", "reconcile", "e", "--state", "failed", "--actor", "a", "--reason", "r"],
      { kind: "effect.reconcile", effectId: "e", state: "failed", externalResourceId: null, actor: "a", reason: "r" },
    ],
  ] as const)("parses %j exactly", (args, expected) => expect(parseAdminCommand([...args])).toEqual(expected));

  it("keeps every contract field name compile-time and runtime fixed", () => {
    const command = parseAdminCommand([
      "channel",
      "set",
      "g",
      "c",
      "--observe",
      "true",
      "--mentions",
      "false",
      "--actor",
      "a",
      "--reason",
      "r",
    ]);
    expect(command).toHaveProperty("observeEvents");
    expect(command).toHaveProperty("respondToMentions");
    expect(command).not.toHaveProperty("observe");
    expect(command).not.toHaveProperty("mentions");
  });

  it.each([
    ["missing", []],
    ["unknown action", ["system", "set"]],
    ["old action", ["system", "set", "--mode", "running", "--actor", "a", "--reason", "r"]],
    ["old option", ["channel", "set", "--guild-id", "g"]],
    ["extra positional", ["channel", "show", "g", "c", "x"]],
    ["blank value", ["channel", "show", " ", "c"]],
    [
      "bad bool",
      ["channel", "set", "g", "c", "--observe", "yes", "--mentions", "false", "--actor", "a", "--reason", "r"],
    ],
    ["bad date", ["migration", "apply", "--backup-confirmed-at", "x", "--actor", "a"]],
    ["bad version", ["character", "activate", "id", "0", "--actor", "a"]],
    [
      "failed external id",
      ["effect", "reconcile", "e", "--state", "failed", "--external-resource-id", "x", "--actor", "a", "--reason", "r"],
    ],
    ["missing external id", ["effect", "reconcile", "e", "--state", "succeeded", "--actor", "a", "--reason", "r"]],
    ["unknown option", ["migration", "status", "--old", "x"]],
  ] as const)("rejects %s", (_, args) => expect(() => parseAdminCommand([...args])).toThrow());

  it.each([
    ["--help", "c"],
    ["--guild-id", "c"],
  ])("rejects option-like channel show token %s", (token, channelId) => {
    expect(() => parseAdminCommand(["channel", "show", token, channelId])).toThrow();
  });

  it.each([
    ["actor", ["migration", "apply", "--backup-confirmed-at", "2026-07-24T00:00:00Z", "--actor", "a", "--actor", "b"]],
    ["actor equals", ["migration", "apply", "--backup-confirmed-at=2026-07-24T00:00:00Z", "--actor=a", "--actor=b"]],
    [
      "backup",
      [
        "migration",
        "apply",
        "--backup-confirmed-at",
        "2026-07-24T00:00:00Z",
        "--backup-confirmed-at",
        "2026-07-24T01:00:00Z",
        "--actor",
        "a",
      ],
    ],
    [
      "state",
      ["effect", "reconcile", "e", "--state", "failed", "--state", "succeeded", "--actor", "a", "--reason", "r"],
    ],
    ["reason", ["system", "stop", "--actor", "a", "--reason", "r1", "--reason", "r2"]],
  ] as const)("rejects duplicate %s", (_, args) => expect(() => parseAdminCommand([...args])).toThrow());

  it.each([
    ["2026-07-24T00:00:00Z", new Date("2026-07-24T00:00:00Z")],
    ["2026-07-24T09:00:00+09:00", new Date("2026-07-24T00:00:00Z")],
  ])("accepts ISO datetime %s", (value, expected) => {
    expect(parseAdminCommand(["migration", "apply", "--backup-confirmed-at", value, "--actor", "a"])).toEqual({
      kind: "migration.apply",
      backupConfirmedAt: expected,
      actor: "a",
    });
  });

  it.each(["2026-07-24", "2026-07-24T00:00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "not-a-date"])(
    "rejects non-valid ISO datetime %s without echoing input",
    (value) => {
      try {
        parseAdminCommand(["migration", "apply", "--backup-confirmed-at", value, "--actor", "a"]);
        throw new Error("expected parser to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(value);
      }
    },
  );
});
```

`src/config/runtime-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadAdminConfig, loadGatewayConfig, loadWorkerConfig } from "./runtime-config.js";

const base = { DATABASE_URL: "postgres://user:pass@localhost/db" };

describe("runtime config", () => {
  it("loads gateway defaults and trimmed admin ids", () => {
    const config = loadGatewayConfig({ ...base, DISCORD_TOKEN: " token ", VICISSITUDE_GUILD_ID: " guild ", VICISSITUDE_ADMIN_USER_IDS: " a, ,b " });
    expect(config).toMatchObject({ discordToken: "token", guildId: "guild", adminIds: ["a", "b"], healthPort: 8080, characterId: "primary" });
  });
  it("requires gateway secrets and valid ports", () => {
    expect(() => loadGatewayConfig(base)).toThrow();
    expect(() => loadGatewayConfig({ ...base, DISCORD_TOKEN: "x", VICISSITUDE_GUILD_ID: "g", VICISSITUDE_ADMIN_USER_IDS: "a", VICISSITUDE_GATEWAY_HEALTH_PORT: "0" })).toThrow();
    expect(() => loadGatewayConfig({ ...base, DISCORD_TOKEN: "x", VICISSITUDE_GUILD_ID: "g", VICISSITUDE_ADMIN_USER_IDS: "a", VICISSITUDE_GATEWAY_HEALTH_PORT: "70000" })).toThrow();
  });
  it("loads worker without discord secrets", () => {
    expect(loadWorkerConfig(base)).toMatchObject({ workerId: "cognition-1", healthPort: 8081, characterId: "primary" });
  });
  it("requires database URL and rejects blank admin ids and bad protocols", () => {
    expect(() => loadAdminConfig({ ...base, VICISSITUDE_ADMIN_USER_IDS: " , " })).not.toThrow();
    expect(() => loadGatewayConfig({ ...base, DISCORD_TOKEN: "x", VICISSITUDE_GUILD_ID: "g", VICISSITUDE_ADMIN_USER_IDS: " , " })).toThrow();
    expect(() => loadAdminConfig({ DATABASE_URL: "sqlite://db" })).toThrow();
  });
});
```

- [ ] **Step 2: Run unit tests and verify they fail**

Run: `nix develop -c pnpm test:unit`

Expected: FAIL because runtime config and admin command parsing do not exist.

- [ ] **Step 3: Implement typed runtime configuration**

`src/config/runtime-config.ts`:

```ts
import { z } from "zod";

const envString = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1);
const database = z
  .string()
  .trim()
  .refine((v) => /^postgres(?:ql)?:\/\//u.test(v), "DATABASE_URL must use postgres protocol");
const common = z
  .object({
    DATABASE_URL: database,
    VICISSITUDE_CHARACTER_ID: z.string().trim().min(1).default("primary"),
    VICISSITUDE_MODEL_ROUTES_PATH: z.string().trim().min(1).default("config/model-routes.json"),
    VICISSITUDE_MIGRATIONS_DIR: z.string().trim().min(1).default("migrations"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  })
  .passthrough();
const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);
const raw = (input: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
export type CommonConfig = z.infer<typeof common>;
export function loadGatewayConfig(input: NodeJS.ProcessEnv) {
  const value = common
    .extend({
      DISCORD_TOKEN: envString("DISCORD_TOKEN"),
      VICISSITUDE_GUILD_ID: envString("VICISSITUDE_GUILD_ID"),
      VICISSITUDE_ADMIN_USER_IDS: z
        .string()
        .transform((v) =>
          v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        )
        .refine((v) => v.length > 0, "at least one admin id"),
      VICISSITUDE_GATEWAY_HEALTH_PORT: port(8080),
    })
    .parse(raw(input));
  if (value.VICISSITUDE_ADMIN_USER_IDS.some((id) => /\s/u.test(id)))
    throw new Error("admin IDs must not contain whitespace");
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
    discordToken: value.DISCORD_TOKEN,
    guildId: value.VICISSITUDE_GUILD_ID,
    adminIds: value.VICISSITUDE_ADMIN_USER_IDS,
    healthPort: value.VICISSITUDE_GATEWAY_HEALTH_PORT,
  };
}
export function loadWorkerConfig(input: NodeJS.ProcessEnv) {
  const value = common
    .extend({
      VICISSITUDE_WORKER_ID: z.string().trim().min(1).default("cognition-1"),
      VICISSITUDE_WORKER_HEALTH_PORT: port(8081),
    })
    .parse(raw(input));
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
    workerId: value.VICISSITUDE_WORKER_ID,
    healthPort: value.VICISSITUDE_WORKER_HEALTH_PORT,
  };
}
export function loadAdminConfig(input: NodeJS.ProcessEnv) {
  const value = common.parse(raw(input));
  return {
    databaseUrl: value.DATABASE_URL,
    characterId: value.VICISSITUDE_CHARACTER_ID,
    modelRoutesPath: value.VICISSITUDE_MODEL_ROUTES_PATH,
    migrationsDir: value.VICISSITUDE_MIGRATIONS_DIR,
    logLevel: value.LOG_LEVEL,
  };
}
```

Update `.env.example` with:

```dotenv
VICISSITUDE_GUILD_ID=
VICISSITUDE_ADMIN_USER_IDS=
VICISSITUDE_GATEWAY_HEALTH_PORT=8080
VICISSITUDE_WORKER_HEALTH_PORT=8081
VICISSITUDE_WORKER_ID=cognition-1
```

- [ ] **Step 4: Implement structured logging with mandatory redaction**

`src/observability/logger.ts`:

```ts
import pino, { type DestinationStream, type Logger } from "pino";

const secretKeys = new Set(["discordtoken", "databaseurl", "apikey", "authorization"]);
const keyName = (key: string) => key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
function sanitizeString(value: string): string {
  const redacted = value
    .replaceAll(/authorization\s*[:=][^\r\n]+/giu, "authorization: [REDACTED]")
    .replaceAll(/((?:token|api[_-]?key|discord[_-]?token|database[_-]?url)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replaceAll(/postgres(?:ql)?:\/\/[^\s"'<>|]+/giu, "[REDACTED]");
  return Array.from(redacted, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f ? "?" : character;
  }).join("");
}
function sanitize(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
      ...(value.stack === undefined ? {} : { stack: sanitizeString(value.stack) }),
    };
  }
  const prior = seen.get(value);
  if (prior !== undefined) return "[Circular]";
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(sanitize(item, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value))
    result[key] = secretKeys.has(keyName(key)) ? "[REDACTED]" : sanitize(item, seen);
  return result;
}
export function createLogger(options: { level: string; destination?: DestinationStream }): Logger {
  const logger = pino(
    {
      level: options.level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        logMethod(input, method) {
          for (let index = 0; index < input.length; index++) input[index] = sanitize(input[index]);
          method.apply(this, input);
        },
      },
    },
    options.destination,
  );
  const wrapChild = (parent: Logger): Logger => {
    const child = parent.child.bind(parent);
    parent.child = ((bindings: Parameters<Logger["child"]>[0], childOptions?: Parameters<Logger["child"]>[1]) => {
      const sanitized = sanitize(bindings) as object;
      return wrapChild(
        (childOptions === undefined ? child(sanitized) : child(sanitized, childOptions)) as unknown as Logger,
      );
    }) as unknown as Logger["child"];
    return parent;
  };
  return wrapChild(logger);
}
```

Do not log canonical event `content`, model prompts, model responses, or pi thinking. Log only IDs, states, durations, provider/model names, and bounded error strings.

`src/observability/logger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger", () => {
  it("redacts nested secrets and emits ISO timestamps", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    logger.info(
      {
        DISCORD_TOKEN: "token",
        config: { DATABASE_URL: "postgres://secret" },
        request: { headers: { authorization: "Bearer secret" } },
        apiKey: "key",
      },
      "hello",
    );
    expect(lines.join(" ")).not.toContain("token");
    expect(lines.join(" ")).not.toContain("secret");
    expect(lines.join(" ")).not.toContain("key");
    expect(JSON.parse(lines[0]!).time).toMatch(/Z$/u);
  });
  it("redacts arbitrary-depth arrays without mutating or breaking dates/cycles", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const input: { values: unknown[] } = { values: [] };
    input.values.push({
      config: { request: { headers: { Authorization: "secret-array" }, api_key: "secret-key" } },
      state: "ok",
      date: new Date("2020-01-01T00:00:00Z"),
    });
    input.values.push(input);
    logger.info(input, "nested");
    const serialized = lines.join(" ");
    expect(serialized).not.toContain("secret-array");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("2020-01-01");
    expect(input.values[0]).toMatchObject({ state: "ok" });
  });
  it("redacts child bindings through nested child chains without mutating them", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const bindings = {
      config: { DATABASE_URL: "child-db-secret" },
      values: [{ Authorization: "child-auth-secret" }, { api_key: "child-key-secret" }],
      requestId: "request-123",
    };
    logger.child(bindings).info("direct child");
    const nested = logger.child(bindings).child({ DISCORD_TOKEN: "nested-token-secret", attempt: 2 });

    nested.info({ detail: { database_url: "log-db-secret" } }, "child message");

    const serialized = lines.join(" ");
    expect(serialized).not.toContain("child-db-secret");
    expect(serialized).not.toContain("child-auth-secret");
    expect(serialized).not.toContain("child-key-secret");
    expect(serialized).not.toContain("nested-token-secret");
    expect(serialized).not.toContain("log-db-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("request-123");
    expect(serialized).toContain('"attempt":2');
    expect(bindings).toEqual({
      config: { DATABASE_URL: "child-db-secret" },
      values: [{ Authorization: "child-auth-secret" }, { api_key: "child-key-secret" }],
      requestId: "request-123",
    });
  });
  it("redacts every log argument including strings, formats, errors, and control characters", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const error = new Error("authorization: Bearer error-secret token=error-token");
    error.stack = `Error: ${error.message}\n    at /tmp/authorization: Bearer stack-secret`;
    const input = {
      message: "token=input-token",
      nested: { DATABASE_URL: "postgres://db-user:db-secret@host/db" },
      date: new Date("2020-01-01T00:00:00Z"),
    };

    logger.info("authorization: Bearer string-secret\napi_key: key-secret");
    logger.info("request %s token=%s", "authorization: Bearer format-secret", "token=format-token");
    logger.error(error, "DISCORD_TOKEN=error-discord");
    logger.info(input, "postgresql://user:password@host/db\u0000");

    const serialized = lines.join(" ");
    for (const secret of [
      "string-secret",
      "key-secret",
      "authorization: Bearer format-secret",
      "format-token",
      "error-secret",
      "error-token",
      "stack-secret",
      "error-discord",
      "input-token",
      "db-secret",
      "password",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("2020-01-01");
    expect(serialized).toContain("request");
    expect(
      Array.from(serialized.replaceAll("\n", ""), (character) => character.codePointAt(0) ?? 0).every(
        (code) => code >= 0x20 && code !== 0x7f,
      ),
    ).toBe(true);
    expect(input).toEqual({
      message: "token=input-token",
      nested: { DATABASE_URL: "postgres://db-user:db-secret@host/db" },
      date: new Date("2020-01-01T00:00:00Z"),
    });
    expect(serialized).toContain('"name":"Error"');
    expect(serialized).toContain('"message":"');
  });
  it("redacts every authorization scheme and complete postgres URLs", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    const values = [
      "Authorization: Basic basic-credential",
      "authorization=Digest digest-credential",
      "Authorization: Custom custom-credential; next=ok",
      "postgres://user@host?password=query-password&token=query-token",
      "postgresql://:colon-password@host/db",
      "postgres://@host/db?sslpassword=empty-user-password",
      "postgresql://host/db?password=query-only-password",
    ];
    logger.info(values.join(" | "));
    const error = new Error(`stack postgresql://${values[3]}`);
    logger.error(error);

    const serialized = lines.join(" ");
    for (const secret of [
      "basic-credential",
      "digest-credential",
      "custom-credential",
      "query-password",
      "query-token",
      "colon-password",
      "empty-user-password",
      "query-only-password",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized.match(/postgres(?:ql)?:\/\//giu)).toBeNull();
  });
  it("redacts authorization lines through Digest and AWS signatures without consuming the next event", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", destination: { write: (value: string) => lines.push(value) } });
    logger.info(
      'Authorization: Digest username="digest-user", realm="digest-realm", response="digest-response"\n' +
        "eventId=event-456",
    );
    logger.info(
      "authorization=AWS4-HMAC-SHA256 Credential=aws-credential, SignedHeaders=aws-headers, Signature=aws-signature\n" +
        "eventId=event-789",
    );

    const serialized = lines.join(" ");
    for (const secret of [
      "digest-user",
      "digest-realm",
      "digest-response",
      "aws-credential",
      "aws-headers",
      "aws-signature",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("event-456");
    expect(serialized).toContain("event-789");
  });
});
```

- [ ] **Step 5: Implement the exact admin command union and parser**

`src/modules/admin/admin-command.ts`:

```ts
import { parseArgs } from "node:util";
import { z } from "zod";

type ActorReason = { actor: string; reason: string };
export type AdminCommand =
  | { kind: "migration.status" }
  | ({ kind: "migration.apply"; backupConfirmedAt: Date } & Pick<ActorReason, "actor">)
  | ({ kind: "system.set"; mode: "running" | "draining" | "stopped" } & ActorReason)
  | { kind: "channel.show"; guildId: string; channelId: string }
  | ({ kind: "channel.set"; guildId: string; channelId: string; observeEvents: boolean; respondToMentions: boolean } & ActorReason)
  | ({ kind: "character.import"; path: string } & Pick<ActorReason, "actor">)
  | ({ kind: "character.activate"; characterId: string; version: number } & Pick<ActorReason, "actor">)
  | { kind: "effect.inspect"; effectId: string }
  | ({ kind: "effect.reconcile"; effectId: string; state: "succeeded" | "failed"; externalResourceId: string | null } & ActorReason);

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const booleanValue = (value: unknown, name: string): boolean => {
  const normalized = text(value, name);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
};
const actorReason = (values: Record<string, unknown>): ActorReason => ({ actor: text(values.actor, "actor"), reason: text(values.reason, "reason") });
const isoDatetime = z.iso.datetime({ offset: true });

function parse(argv: string[], options: Record<string, { type: "string" }>, positional: number) {
  try {
    const seen = new Set<string>();
    for (const argument of argv) {
      if (argument === "--") break;
      if (!argument.startsWith("--")) continue;
      const name = argument.slice(2).split("=", 1)[0] ?? "";
      if (seen.has(name)) throw new Error("duplicate option");
      seen.add(name);
    }
    const result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    if (result.positionals.length !== positional) throw new Error("invalid positional arguments");
    return result;
  } catch {
    throw new Error("invalid command arguments");
  }
}

export function parseAdminCommand(argv: string[]): AdminCommand {
  const [group, action, ...args] = argv;
  if (!group || !action) throw new Error("command is required");
  const command = `${group}.${action}`;
  if (command === "migration.status") {
    if (args.length) throw new Error("unexpected argument");
    return { kind: "migration.status" };
  }
  if (command === "system.resume" || command === "system.drain" || command === "system.stop") {
    const result = parse(args, { actor: { type: "string" }, reason: { type: "string" } }, 0);
    const mode = command === "system.resume" ? "running" : command === "system.drain" ? "draining" : "stopped";
    return { kind: "system.set", mode, ...actorReason(result.values) };
  }
  if (command === "channel.show") {
    const result = parse(args, {}, 2);
    return { kind: "channel.show", guildId: text(result.positionals[0], "guildId"), channelId: text(result.positionals[1], "channelId") };
  }
  if (command === "migration.apply") {
    const result = parse(args, { "backup-confirmed-at": { type: "string" }, actor: { type: "string" } }, 0);
    const value = text(result.values["backup-confirmed-at"], "backup-confirmed-at");
    const validValue = isoDatetime.safeParse(value);
    if (!validValue.success) throw new Error("invalid backup timestamp");
    return { kind: "migration.apply", backupConfirmedAt: new Date(validValue.data), actor: text(result.values.actor, "actor") };
  }
  if (command === "channel.set") {
    const result = parse(args, { observe: { type: "string" }, mentions: { type: "string" }, actor: { type: "string" }, reason: { type: "string" } }, 2);
    const [guildId, channelId] = result.positionals;
    return { kind: "channel.set", guildId: text(guildId, "guildId"), channelId: text(channelId, "channelId"), observeEvents: booleanValue(result.values.observe, "observe"), respondToMentions: booleanValue(result.values.mentions, "mentions"), ...actorReason(result.values) };
  }
  if (command === "character.import") {
    const result = parse(args, { actor: { type: "string" } }, 1);
    return { kind: "character.import", path: text(result.positionals[0], "path"), actor: text(result.values.actor, "actor") };
  }
  if (command === "character.activate") {
    const result = parse(args, { actor: { type: "string" } }, 2);
    const version = Number(text(result.positionals[1], "version"));
    if (!Number.isInteger(version) || version < 1) throw new Error("invalid version");
    return { kind: "character.activate", characterId: text(result.positionals[0], "characterId"), version, actor: text(result.values.actor, "actor") };
  }
  if (command === "effect.inspect") {
    const result = parse(args, {}, 1);
    return { kind: "effect.inspect", effectId: text(result.positionals[0], "effectId") };
  }
  if (command === "effect.reconcile") {
    const result = parse(args, { state: { type: "string" }, "external-resource-id": { type: "string" }, actor: { type: "string" }, reason: { type: "string" } }, 1);
    const state = text(result.values.state, "state");
    if (state !== "succeeded" && state !== "failed") throw new Error("invalid state");
    const external = result.values["external-resource-id"];
    if (state === "succeeded" && external === undefined) throw new Error("external resource id is required");
    if (state === "failed" && external !== undefined) throw new Error("failed effect cannot have external resource id");
    return { kind: "effect.reconcile", effectId: text(result.positionals[0], "effectId"), state, externalResourceId: external === undefined ? null : text(external, "externalResourceId"), ...actorReason(result.values) };
  }
  throw new Error("unknown command");
}
```

The complete implementation is shown above.

- [ ] **Step 6: Implement the admin CLI application**

`src/apps/admin-cli.ts`:

```ts
import { lstat, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus, runMigrations } from "../adapters/postgres/migrations.js";
import { PostgresChannelCapabilityRepository } from "../adapters/postgres/channel-capability-repository.js";
import { PostgresCharacterRepository } from "../adapters/postgres/character-repository.js";
import { PostgresEffectQueue } from "../adapters/postgres/effect-queue.js";
import { PostgresSystemControlRepository } from "../adapters/postgres/system-control-repository.js";
import { CharacterDefinitionSchema } from "../modules/characters/character-definition.js";
import type { ChannelCapabilities } from "../modules/channels/channel-capability.js";
import { loadAdminConfig } from "../config/runtime-config.js";
import { parseAdminCommand, type AdminCommand } from "../modules/admin/admin-command.js";
export interface AdminOutput {
  write(value: unknown): void;
}
type ChannelPatch = Pick<ChannelCapabilities, "observeEvents" | "respondToMentions">;
type AdminChannelRepository = Pick<PostgresChannelCapabilityRepository, "get"> & {
  patch(
    guildId: string,
    channelId: string,
    changes: ChannelPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<ChannelCapabilities>;
};
export interface AdminDependencies {
  createClient?: (url: string) => Sql;
  now?: () => Date;
  lstat?: typeof lstat;
  open?: typeof open;
  migrationStatus?: typeof migrationStatus;
  runMigrations?: typeof runMigrations;
  system?: (sql: Sql) => Pick<PostgresSystemControlRepository, "setMode">;
  channel?: (sql: Sql) => AdminChannelRepository;
  character?: (sql: Sql) => Pick<PostgresCharacterRepository, "importDraft" | "activate">;
  effect?: (sql: Sql) => Pick<PostgresEffectQueue, "inspect" | "reconcileUnknown">;
  output?: AdminOutput;
}
const write = (d: AdminDependencies, v: unknown) =>
  (d.output ?? { write: (x: unknown) => console.log(JSON.stringify(x)) }).write(v);
const clock = (d: AdminDependencies) => (d.now ?? (() => new Date()))();
const MAX_CHARACTER_FILE_BYTES = 64 * 1024;

async function readCharacterFile(path: string, d: AdminDependencies): Promise<string> {
  const initial = await (d.lstat ?? lstat)(path);
  if (!initial.isFile()) throw new Error("character file must be regular");
  if (initial.size > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
  let handle: FileHandle | undefined;
  try {
    handle = await (d.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile()) throw new Error("character file must be regular");
    if (current.size > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
    const buffer = Buffer.alloc(MAX_CHARACTER_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
      if (offset > MAX_CHARACTER_FILE_BYTES) throw new Error("character file is too large");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await handle?.close();
  }
}
export async function dispatchAdminCommand(
  command: AdminCommand,
  sql: Sql,
  config: ReturnType<typeof loadAdminConfig>,
  d: AdminDependencies = {},
): Promise<void> {
  switch (command.kind) {
    case "migration.status":
      write(d, await (d.migrationStatus ?? migrationStatus)(sql, config.migrationsDir));
      return;
    case "migration.apply": {
      const confirmedAt = command.backupConfirmedAt.getTime();
      if (!Number.isFinite(confirmedAt)) throw new Error("backup confirmation is invalid");
      const age = clock(d).getTime() - confirmedAt;
      if (age < 0 || age > 86400000) throw new Error("backup confirmation is stale");
      const result = await (d.runMigrations ?? runMigrations)(sql, config.migrationsDir, {
        actor: command.actor,
        backupConfirmedAt: command.backupConfirmedAt,
      });
      write(d, {
        applied: result.appliedVersions.length > 0,
        appliedVersions: result.appliedVersions,
        actor: command.actor,
      });
      return;
    }
    case "system.set": {
      const r = (d.system ?? ((db) => new PostgresSystemControlRepository(db)))(sql);
      await r.setMode(command.mode, command.actor, command.reason, clock(d));
      write(d, { mode: command.mode });
      return;
    }
    case "channel.show": {
      const r = (d.channel ?? ((db) => new PostgresChannelCapabilityRepository(db)))(sql);
      write(d, await r.get(command.guildId, command.channelId));
      return;
    }
    case "channel.set": {
      const r = (
        d.channel ?? ((db) => new PostgresChannelCapabilityRepository(db) as unknown as AdminChannelRepository)
      )(sql);
      const next = await r.patch(
        command.guildId,
        command.channelId,
        { observeEvents: command.observeEvents, respondToMentions: command.respondToMentions },
        command.actor,
        command.reason,
        clock(d),
      );
      write(d, next);
      return;
    }
    case "character.import": {
      const value = CharacterDefinitionSchema.parse(JSON.parse(await readCharacterFile(command.path, d)));
      await (d.character ?? ((db) => new PostgresCharacterRepository(db)))(sql).importDraft(
        value,
        command.actor,
        clock(d),
      );
      write(d, { imported: `${value.characterId}@${value.version}` });
      return;
    }
    case "character.activate":
      await (d.character ?? ((db) => new PostgresCharacterRepository(db)))(sql).activate(
        command.characterId,
        command.version,
        command.actor,
        clock(d),
      );
      write(d, { activated: `${command.characterId}@${command.version}` });
      return;
    case "effect.inspect": {
      const r = (d.effect ?? ((db) => new PostgresEffectQueue(db)))(sql);
      write(d, await r.inspect(command.effectId));
      return;
    }
    case "effect.reconcile": {
      const r = (d.effect ?? ((db) => new PostgresEffectQueue(db)))(sql);
      await r.reconcileUnknown(
        command.effectId,
        command.state,
        command.externalResourceId,
        command.actor,
        command.reason,
        clock(d),
      );
      write(d, { reconciled: command.effectId, state: command.state });
      return;
    }
  }
}
export async function main(argv = process.argv.slice(2), env = process.env, d: AdminDependencies = {}): Promise<void> {
  let sql: Sql | undefined;
  let failed = false;
  try {
    const config = loadAdminConfig(env);
    sql = (d.createClient ?? createPostgresClient)(config.databaseUrl);
    await dispatchAdminCommand(parseAdminCommand(argv), sql, config, d);
  } catch {
    failed = true;
  } finally {
    if (sql) {
      try {
        await sql.end();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) {
    console.error("Admin command failed");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Admin command failed");
    process.exitCode = 1;
  });
```

`src/apps/admin-cli.test.ts`:

```ts
import { mkdtemp, open as fsOpen, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchAdminCommand, main } from "./admin-cli.js";
const config = {
  databaseUrl: "postgres://db",
  characterId: "primary",
  modelRoutesPath: "routes",
  migrationsDir: "migrations",
  logLevel: "info",
} as const;
const sql = {} as never;
const at = new Date("2026-07-24T00:00:00Z");
const out = () => ({ write: vi.fn() });
describe("admin dispatch", () => {
  it("status never applies", async () => {
    const status = vi.fn(async () => []);
    const apply = vi.fn(async () => ({ appliedVersions: ["0001"], appliedAt: at }));
    const output = out();
    await dispatchAdminCommand({ kind: "migration.status" }, sql, config, {
      migrationStatus: status as never,
      runMigrations: apply,
      output,
    });
    expect(status).toHaveBeenCalledWith(sql, "migrations");
    expect(apply).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith([]);
  });
  it("applies only fresh backups", async () => {
    const apply = vi.fn(async () => ({ appliedVersions: ["0001"], appliedAt: at }));
    const output = out();
    const d = { runMigrations: apply, now: () => at, output };
    await dispatchAdminCommand(
      { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-23T12:00:00Z"), actor: "a" },
      sql,
      config,
      d,
    );
    expect(apply).toHaveBeenCalledWith(sql, "migrations", {
      actor: "a",
      backupConfirmedAt: new Date("2026-07-23T12:00:00Z"),
    });
    expect(output.write).toHaveBeenCalledWith({ applied: true, appliedVersions: ["0001"], actor: "a" });
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-24T00:00:01Z"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledOnce();
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("invalid"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand(
        { kind: "migration.apply", backupConfirmedAt: new Date("2026-07-22T23:59:59Z"), actor: "a" },
        sql,
        config,
        d,
      ),
    ).rejects.toThrow();
    expect(apply).toHaveBeenCalledOnce();
  });
  it("calls system.set exactly", async () => {
    const setMode = vi.fn(async () => undefined);
    const output = out();
    await dispatchAdminCommand({ kind: "system.set", mode: "draining", actor: "a", reason: "r" }, sql, config, {
      system: () => ({ setMode }) as never,
      now: () => at,
      output,
    });
    expect(setMode).toHaveBeenCalledWith("draining", "a", "r", at);
    expect(output.write).toHaveBeenCalledWith({ mode: "draining" });
  });
  it("patches channel capabilities and writes the returned value", async () => {
    const value = {
      guildId: "g",
      channelId: "c",
      observeEvents: false,
      respondToMentions: false,
      spontaneousJoin: true,
      spontaneousTopic: false,
      addReactions: true,
      createThreads: false,
      shareFiles: true,
      shareExternalLinks: false,
    };
    const get = vi.fn(async () => value);
    const set = vi.fn(async () => undefined);
    const patch = vi.fn(async () => ({ ...value, observeEvents: true, respondToMentions: true }));
    const output = out();
    const expectedNext = { ...value, observeEvents: true, respondToMentions: true };
    await dispatchAdminCommand(
      {
        kind: "channel.set",
        guildId: "g",
        channelId: "c",
        observeEvents: true,
        respondToMentions: true,
        actor: "a",
        reason: "r",
      },
      sql,
      config,
      { channel: () => ({ get, set, patch }), now: () => at, output },
    );
    expect(patch).toHaveBeenCalledWith("g", "c", { observeEvents: true, respondToMentions: true }, "a", "r", at);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith(expectedNext);
    expect(output.write.mock.calls[0]?.[0]).toEqual(expectedNext);
    await dispatchAdminCommand({ kind: "channel.show", guildId: "g", channelId: "c" }, sql, config, {
      channel: () => ({ get, patch }),
      output,
    });
    expect(output.write).toHaveBeenLastCalledWith(value);
  });
  it("imports and activates character", async () => {
    const value = {
      schemaVersion: 1,
      characterId: "primary",
      version: 1,
      name: "P",
      language: "ja",
      systemPrompt: "x",
      failureMessages: ["f"],
    };
    const importDraft = vi.fn(async () => undefined);
    const activate = vi.fn(async () => undefined);
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const path = join(directory, "character.json");
    await writeFile(path, JSON.stringify(value));
    const output = out();
    const openedWith: unknown[] = [];
    const d = {
      open: async (filePath: string, flags: number) => {
        openedWith.push(flags);
        return fsOpen(filePath, flags);
      },
      character: () => ({ importDraft, activate }),
      now: () => at,
      output,
    } as never;
    await dispatchAdminCommand({ kind: "character.import", path, actor: "a" }, sql, config, d);
    await dispatchAdminCommand(
      { kind: "character.activate", characterId: "primary", version: 1, actor: "a" },
      sql,
      config,
      d,
    );
    expect(importDraft).toHaveBeenCalledWith(value, "a", at);
    expect(activate).toHaveBeenCalledWith("primary", 1, "a", at);
    expect(output.write).toHaveBeenNthCalledWith(1, { imported: "primary@1" });
    expect(output.write).toHaveBeenNthCalledWith(2, { activated: "primary@1" });
    expect(openedWith).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects unsafe and oversized character files without importing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const character = vi.fn(async () => undefined);
    const regular = join(directory, "regular.json");
    const oversized = join(directory, "oversized.json");
    const link = join(directory, "link.json");
    await writeFile(regular, "[]");
    await writeFile(oversized, "x".repeat(64 * 1024 + 1));
    await symlink(regular, link);
    const d = { character: () => ({ importDraft: character }), output: out() } as never;
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: directory, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: regular, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: oversized, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: link, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    expect(character).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects invalid UTF-8 and malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "admin-cli-"));
    const invalidUtf8 = join(directory, "invalid-utf8.json");
    const invalidJson = join(directory, "invalid-json.json");
    await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
    await writeFile(invalidJson, "{");
    const d = { character: () => ({ importDraft: vi.fn() }), output: out() } as never;
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: invalidUtf8, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await expect(
      dispatchAdminCommand({ kind: "character.import", path: invalidJson, actor: "a" }, sql, config, d),
    ).rejects.toThrow();
    await rm(directory, { recursive: true, force: true });
  });
  it("uses effect queue positional APIs", async () => {
    const inspect = vi.fn(async () => ({}));
    const reconcileUnknown = vi.fn(async () => undefined);
    const output = out();
    await dispatchAdminCommand({ kind: "effect.inspect", effectId: "e" }, sql, config, {
      effect: () => ({ inspect, reconcileUnknown }) as never,
      output,
    });
    await dispatchAdminCommand(
      { kind: "effect.reconcile", effectId: "e", state: "succeeded", externalResourceId: "x", actor: "a", reason: "r" },
      sql,
      config,
      { effect: () => ({ inspect, reconcileUnknown }) as never, now: () => at, output },
    );
    expect(inspect).toHaveBeenCalledWith("e");
    expect(reconcileUnknown).toHaveBeenCalledWith("e", "succeeded", "x", "a", "r", at);
    expect(output.write).toHaveBeenCalledWith({});
    expect(output.write).toHaveBeenLastCalledWith({ reconciled: "e", state: "succeeded" });
  });

  it("closes the database when dispatch fails", async () => {
    const end = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({ end }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await main(
      ["migration.status"],
      { DATABASE_URL: "postgres://db", MIGRATIONS_DIR: "migrations" },
      {
        createClient,
        migrationStatus: vi.fn(async () => {
          throw new Error("boom");
        }) as never,
      },
    );
    expect(end).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("does not expose dependency or close errors", async () => {
    const secret = "postgres://secret\nTOKEN";
    const end = vi.fn(async () => {
      throw new Error(secret);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await main(
      ["migration.status"],
      { DATABASE_URL: secret, MIGRATIONS_DIR: "migrations" },
      {
        createClient: () => ({ end }) as never,
        migrationStatus: vi.fn(async () => {
          throw new Error(secret);
        }) as never,
      },
    );
    expect(error).toHaveBeenCalledWith("Admin command failed");
    expect(error.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(secret);
    expect(process.exitCode).toBe(1);
    error.mockRestore();
    stderr.mockRestore();
  });
});
```

`PostgresEffectQueue.inspect` and `reconcileUnknown` were implemented in Task 8. Keep all effect reconciliation behind those methods; never interpolate a user-provided identifier into raw SQL.

- [ ] **Step 7: Run configuration and CLI tests**

Run: `nix develop -c pnpm test`

Expected: parser, config, repository, and prior tests PASS.

- [ ] **Step 8: Record the checkpoint**

Run: `nix develop -c pnpm check && git diff --check`

Expected: no errors.

## Task 11: Compose Gateway and Cognition Worker Processes

**Files:**

- Create: `src/shared/health-server.ts`
- Create: `src/shared/process-lifecycle.ts`
- Create: `src/modules/jobs/run-worker.ts`
- Create: `src/modules/effects/run-effect-worker.ts`
- Create: `src/apps/cognition-worker.ts`
- Create: `src/apps/discord-gateway.ts`
- Create: `src/modules/jobs/run-worker.test.ts`
- Create: `src/modules/effects/run-effect-worker.test.ts`
- Create: `src/shared/health-server.test.ts`
- Create: `src/shared/process-lifecycle.test.ts`
- Create: `src/apps/app-lifecycle.ts`
- Create: `src/apps/app-lifecycle.test.ts`
- Create: `src/apps/discord-gateway.test.ts`
- Create: `src/adapters/postgres/gateway-lease.ts`
- Create: `src/adapters/postgres/gateway-lease.test.ts`
- Create: `spec/adapters/postgres/gateway-lease.spec.ts`

- [ ] **Step 1: Write failing loop lifecycle tests**

`src/modules/jobs/run-worker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runOneJob } from "./run-worker.js";
import { JOB_LEASE_MS } from "./run-worker.js";

describe("runOneJob", () => {
  it("claims with a lease and handles the claimed job", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const job = {
      id: "j1",
      kind: "mention_response" as const,
      eventId: "e1",
      attempts: 1,
      maxAttempts: 3,
      leasedUntil: now,
      leaseToken: "l1",
    };
    const queue = { claim: vi.fn().mockResolvedValue(job) };
    const handler = vi.fn().mockResolvedValue(undefined);
    await expect(runOneJob(queue, "worker-1", now, handler)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith(job);
    expect(queue.claim).toHaveBeenCalledWith("worker-1", now, JOB_LEASE_MS);
  });

  it("returns false when no job is available", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(null) };
    await expect(runOneJob(queue, "worker-1", new Date(), vi.fn())).resolves.toBe(false);
  });
});
```

`src/modules/effects/run-effect-worker.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runOneEffect } from "./run-effect-worker.js";

const effect = {
  id: "e1",
  runId: "r1",
  guildId: "g1",
  capabilityChannelId: "c1",
  targetChannelId: "c1",
  targetMessageId: "m1",
  content: "hello",
  attempts: 1,
};
describe("runOneEffect", () => {
  it("rechecks capability and executes an allowed effect", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn() };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: true }),
    };
    const executor = { execute: vi.fn().mockResolvedValue(undefined) };
    const clock = { now: vi.fn().mockReturnValue(new Date("2026-01-01T00:00:00Z")) };
    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);
    expect(executor.execute).toHaveBeenCalledWith(effect, clock);
  });

  it("fails revoked capability without executing", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn().mockResolvedValue(undefined) };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: false }),
    };
    const executor = { execute: vi.fn() };
    const clock = { now: vi.fn().mockReturnValue(new Date("2026-01-01T00:00:00Z")) };
    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);
    expect(queue.fail).toHaveBeenCalledWith("e1", "capability_revoked", clock.now());
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run lifecycle tests and verify they fail**

Run: `nix develop -c pnpm test:unit`

Expected: FAIL because worker loop functions do not exist.

- [ ] **Step 3: Implement one-iteration functions before polling loops**

`src/modules/jobs/run-worker.ts`:

```ts
import type { ClaimedJob, JobQueue } from "./job-queue.js";

export const JOB_LEASE_MS = 60_000;
export async function runOneJob(
  queue: Pick<JobQueue, "claim">,
  workerId: string,
  now: Date,
  handler: (job: ClaimedJob) => Promise<void>,
  onError?: (job: ClaimedJob, error: unknown) => Promise<void>,
): Promise<boolean> {
  const job = await queue.claim(workerId, now, JOB_LEASE_MS);
  if (!job) return false;
  try {
    await handler(job);
  } catch (error) {
    await onError?.(job, error);
    throw error;
  }
  return true;
}
```

`src/modules/effects/run-effect-worker.ts`:

```ts
import type { Clock } from "../../shared/clock.js";
import type { ChannelCapabilities } from "../channels/channel-capability.js";
import type { ClaimedReplyEffect, EffectQueue } from "./effect.js";

interface CapabilityRepository {
  get(guildId: string, channelId: string): Promise<ChannelCapabilities>;
}
interface Executor {
  execute(effect: ClaimedReplyEffect, clock: Clock): Promise<void>;
}
interface Queue extends Pick<EffectQueue, "fail"> {
  claim(workerId: string, now: Date): Promise<ClaimedReplyEffect | null>;
}

export async function runOneEffect(
  queue: Queue,
  capabilities: CapabilityRepository,
  executor: Executor,
  workerId: string,
  clock: Clock,
): Promise<boolean> {
  const effect = await queue.claim(workerId, clock.now());
  if (!effect) return false;
  const capability = await capabilities.get(effect.guildId, effect.capabilityChannelId);
  if (!capability.respondToMentions) {
    await queue.fail(effect.id, "capability_revoked", clock.now());
    return true;
  }
  await executor.execute(effect, clock);
  return true;
}
```

This is the second authorization check required by the architecture.

- [ ] **Step 4: Implement health and signal helpers**

`src/shared/health-server.ts`:

```ts
import { createServer, type Server } from "node:http";

export interface HealthState {
  ready: boolean;
  details?: Record<string, unknown>;
}
export function createHealthServer(initial: HealthState = { ready: false }) {
  let state = initial;
  let server: Server | undefined;
  return {
    setReady(ready: boolean, details?: Record<string, unknown>) {
      state = details ? { ready, details } : { ready };
    },
    listen(port: number, host = "127.0.0.1"): Promise<Server> {
      server = createServer((request, response) => {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end();
          return;
        }
        const status = request.url === "/live" ? 200 : request.url === "/ready" ? (state.ready ? 200 : 503) : 404;
        response.statusCode = status;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            healthy: status === 200,
            ready: state.ready,
            ...(state.details ? { details: state.details } : {}),
          }),
        );
      });
      return new Promise((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => resolve(server!));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!server) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
```

`src/shared/health-server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHealthServer } from "./health-server.js";

describe("health server", () => {
  it("serves live and readiness with JSON status", async () => {
    const health = createHealthServer();
    const server = await health.listen(0);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    expect((await fetch(`${base}/live`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(503);
    expect((await fetch(`${base}/unknown`)).status).toBe(404);
    expect((await fetch(`${base}/live`, { method: "POST" })).status).toBe(405);
    await health.close();
  });
});
```

`src/shared/process-lifecycle.ts`:

```ts
import type { EventEmitter } from "node:events";

export interface ShutdownEmitter {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export function shutdownSignal(emitter: ShutdownEmitter = process as unknown as EventEmitter): Promise<AbortSignal> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const onSignal = () => {
      emitter.off("SIGINT", onSignal);
      emitter.off("SIGTERM", onSignal);
      controller.abort();
      resolve(controller.signal);
    };
    emitter.once("SIGINT", onSignal);
    emitter.once("SIGTERM", onSignal);
  });
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) return Promise.reject(new RangeError("sleep duration must be non-negative"));
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
```

`src/shared/process-lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { sleep, shutdownSignal } from "./process-lifecycle.js";

describe("process lifecycle", () => {
  it("aborts from one signal and cleans listeners", async () => {
    const emitter = new EventEmitter();
    const result = shutdownSignal(emitter);
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    emitter.emit("SIGTERM");
    const signal = await result;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
    emitter.emit("SIGINT");
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("uses the real Node process without installing test leaks", async () => {
    const before = process.listenerCount("SIGINT");
    const result = shutdownSignal();
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT");
    const signal = await result;
    expect(signal.aborted).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("rejects invalid sleep duration", async () => {
    await expect(sleep(-1)).rejects.toThrow();
  });
  it("resolves normally when aborted", async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
```

`src/apps/app-lifecycle.ts`:

```ts
import type { MigrationStatus } from "../adapters/postgres/migrations.js";
import type { ClaimedJob, JobQueue } from "../modules/jobs/job-queue.js";
import { runOneJob } from "../modules/jobs/run-worker.js";

export function requireNoPendingMigrations(statuses: Pick<MigrationStatus, "state">[], production?: unknown): void {
  if (statuses.some((status) => status.state === "pending")) throw new Error("pending migrations");
  if (arguments.length > 1 && production == null) throw new Error("production character is required");
}
export function createInFlightTracker() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(promise: Promise<T>): Promise<T> {
      pending.add(promise);
      void promise.then(
        () => {
          pending.delete(promise);
        },
        () => {
          pending.delete(promise);
        },
      );
      return promise;
    },
    async drain(): Promise<void> {
      await Promise.allSettled(pending);
    },
    get size() {
      return pending.size;
    },
  };
}
export async function runWorkerIteration(
  queue: Pick<JobQueue, "claim">,
  workerId: string,
  now: Date,
  handler: (job: ClaimedJob) => Promise<void>,
  failure: (job: ClaimedJob, error: unknown) => Promise<void>,
): Promise<boolean> {
  return runOneJob(queue, workerId, now, handler, failure);
}
```

`src/apps/app-lifecycle.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createInFlightTracker, requireNoPendingMigrations, runWorkerIteration } from "./app-lifecycle.js";

describe("app lifecycle", () => {
  it("rejects pending migrations and missing production character", async () => {
    await expect(Promise.resolve().then(() => requireNoPendingMigrations([{ state: "pending" }]))).rejects.toThrow(
      "pending migrations",
    );
    await expect(
      Promise.resolve().then(() => requireNoPendingMigrations([{ state: "applied" }], null)),
    ).rejects.toThrow("production character");
  });
  it("drains in-flight work before close", async () => {
    const tracker = createInFlightTracker();
    let released = false;
    const pending = tracker.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          released = true;
          resolve();
        }, 5),
      ),
    );
    await tracker.drain();
    expect(released).toBe(true);
    await pending;
  });
  it("tracks rejected promises without an unhandled derived rejection", async () => {
    const tracker = createInFlightTracker();
    const rejected = tracker.track(Promise.reject(new Error("expected")));
    await tracker.drain();
    await expect(rejected).rejects.toThrow("expected");
    expect(tracker.size).toBe(0);
  });
  it("applies failure policy when worker handler fails", async () => {
    const fail = vi.fn().mockResolvedValue(undefined);
    const queue = {
      claim: vi.fn().mockResolvedValue({
        id: "j",
        eventId: "e",
        attempts: 1,
        maxAttempts: 3,
        leaseToken: "l",
        kind: "mention_response",
        leasedUntil: new Date(),
      }),
    };
    await expect(
      runWorkerIteration(
        queue,
        "w",
        new Date(),
        async () => {
          throw new Error("boom");
        },
        async (job, error) => fail(job, error),
      ),
    ).rejects.toThrow("boom");
    expect(fail).toHaveBeenCalled();
  });
});
```

### Step 4.5: Add the durable gateway lease

`src/adapters/postgres/gateway-lease.ts`:

```ts
const KEY = "vicissitude:discord-gateway";
interface ReservedConnection {
  unsafe(query: string): Promise<unknown[]>;
  release(): void | Promise<void>;
}
interface ReservableSql {
  reserve(): Promise<ReservedConnection>;
}

export async function acquireGatewayLease(sql: ReservableSql): Promise<{ release(): Promise<void> }> {
  const connection = await sql.reserve();
  let released = false;
  try {
    const rows = (await connection.unsafe(
      `select pg_try_advisory_lock(hashtextextended('${KEY}', 0)) as locked`,
    )) as Array<{ locked: boolean }>;
    if (!rows[0]?.locked) throw new Error("Gateway is already running");
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await connection.unsafe(`select pg_advisory_unlock(hashtextextended('${KEY}', 0))`);
        } finally {
          await connection.release();
        }
      },
    };
  } catch (error) {
    await Promise.resolve(connection.release()).catch(() => undefined);
    throw error;
  }
}
```

`src/adapters/postgres/gateway-lease.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { acquireGatewayLease } from "./gateway-lease.js";

describe("gateway lease", () => {
  it("acquires once, rejects contention, and releases idempotently", async () => {
    const reserved = vi.fn().mockResolvedValue({
      unsafe: vi
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([]),
      release: vi.fn().mockResolvedValue(undefined),
    });
    const first = await acquireGatewayLease({ reserve: reserved } as never);
    await expect(
      acquireGatewayLease({
        reserve: vi.fn().mockResolvedValue({
          unsafe: vi.fn().mockResolvedValue([{ locked: false }]),
          release: vi.fn().mockResolvedValue(undefined),
        }),
      } as never),
    ).rejects.toThrow("already running");
    await first.release();
    await first.release();
    expect(reserved).toHaveBeenCalledOnce();
  });
});
```

`spec/adapters/postgres/gateway-lease.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPostgresClient } from "../../../src/adapters/postgres/client.js";
import { acquireGatewayLease } from "../../../src/adapters/postgres/gateway-lease.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("gateway advisory lease", () => {
  it("serializes gateway recovery ownership across reserved connections", async () => {
    const firstSql = createPostgresClient(url!);
    const secondSql = createPostgresClient(url!);
    const first = await acquireGatewayLease(firstSql);
    await expect(acquireGatewayLease(secondSql)).rejects.toThrow("already running");
    await first.release();
    const third = await acquireGatewayLease(secondSql);
    await third.release();
    await firstSql.end({ timeout: 1 });
    await secondSql.end({ timeout: 1 });
  });
});
```

Run: `nix develop -c pnpm exec vitest run src/adapters/postgres/gateway-lease.test.ts spec/adapters/postgres/gateway-lease.spec.ts`

Expected: the unit test passes, and the PostgreSQL specification is skipped without `TEST_DATABASE_URL` or passes when the test harness supplies it; `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Compose the cognition worker**

`src/apps/cognition-worker.ts`:

```ts
import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus } from "../adapters/postgres/migrations.js";
import { PostgresCharacterRepository } from "../adapters/postgres/character-repository.js";
import { PostgresJobQueue } from "../adapters/postgres/job-queue.js";
import { PostgresDecisionEffectStore } from "../adapters/postgres/decision-effect-store.js";
import { createPiModels } from "../adapters/pi/pi-models.js";
import { PiAgentRuntime } from "../adapters/pi/pi-agent-runtime.js";
import { loadModelRoutes } from "../config/model-routes.js";
import { loadWorkerConfig } from "../config/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { processMention, handleMentionFailure } from "../modules/mentions/process-mention.js";
import { runWorkerIteration } from "./app-lifecycle.js";
import { createHealthServer } from "../shared/health-server.js";
import { sleep, shutdownSignal } from "../shared/process-lifecycle.js";
import { SystemClock } from "../shared/clock.js";

export interface CognitionDependencies {
  sql: Sql;
  migrationStatus: typeof migrationStatus;
  closeSql: () => Promise<void>;
  health: ReturnType<typeof createHealthServer>;
  sleep: typeof sleep;
  shutdown: Promise<AbortSignal>;
  now: () => Date;
  logger: ReturnType<typeof createLogger>;
}

export async function runCognitionWorker(
  config: ReturnType<typeof loadWorkerConfig>,
  d: CognitionDependencies,
): Promise<void> {
  const statuses = await d.migrationStatus(d.sql, config.migrationsDir);
  if (statuses.some((status) => status.state === "pending")) throw new Error("pending migrations");
  const characterRepo = new PostgresCharacterRepository(d.sql);
  const character = await characterRepo.getProduction(config.characterId);
  if (!character) throw new Error("production character is required");
  const routes = await loadModelRoutes(config.modelRoutesPath);
  const runtime = new PiAgentRuntime(createPiModels());
  const queue = new PostgresJobQueue(d.sql);
  const store = new PostgresDecisionEffectStore(d.sql);
  const stopping = { value: false };
  void d.shutdown.then(() => {
    stopping.value = true;
  });
  d.health.setReady(true);
  while (!stopping.value) {
    try {
      const handled = await runWorkerIteration(
        queue,
        config.workerId,
        d.now(),
        (job) => processMention(job, character, routes, runtime, store, { now: d.now }),
        (job, error) => handleMentionFailure(job, error, queue, store, { now: d.now }),
      );
      if (stopping.value) {
        d.health.setReady(false);
        break;
      }
      d.health.setReady(true);
      if (!handled) await d.sleep(250);
    } catch (error) {
      d.health.setReady(false);
      d.logger.error({ err: error }, "Cognition iteration failed");
      await d.sleep(250).catch(() => undefined);
    }
  }
}

export async function main(env = process.env): Promise<void> {
  let sql: Sql | undefined;
  const config = loadWorkerConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const health = createHealthServer({ ready: false });
  try {
    sql = createPostgresClient(config.databaseUrl);
    await health.listen(config.healthPort);
    await runCognitionWorker(config, {
      sql,
      migrationStatus,
      closeSql: () => sql!.end(),
      health,
      sleep,
      shutdown: shutdownSignal(),
      now: () => SystemClock.now(),
      logger,
    });
  } catch {
    logger.error("Cognition worker failed");
    process.exitCode = 1;
  } finally {
    health.setReady(false);
    await health.close().catch(() => undefined);
    await sql?.end().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Cognition worker failed");
    process.exitCode = 1;
  });
```

- [ ] **Step 6: Compose the Discord Gateway**

`src/apps/discord-gateway.ts`:

```ts
import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { Sql } from "postgres";
import { createPostgresClient } from "../adapters/postgres/client.js";
import { migrationStatus } from "../adapters/postgres/migrations.js";
import { PostgresIngestionStore } from "../adapters/postgres/ingestion-store.js";
import { PostgresChannelCapabilityRepository } from "../adapters/postgres/channel-capability-repository.js";
import { PostgresSystemControlRepository } from "../adapters/postgres/system-control-repository.js";
import { PostgresEffectQueue } from "../adapters/postgres/effect-queue.js";
import { DiscordClientMessenger, snapshotDiscordMessage } from "../adapters/discord/discord-client.js";
import { DiscordEffectExecutor } from "../adapters/discord/discord-effect-executor.js";
import { toDiscordMessageInput } from "../adapters/discord/message-snapshot.js";
import { channelCommand, handleChannelCommand } from "../adapters/discord/channel-command.js";
import { ingestDiscordMessage } from "../modules/events/ingest-message.js";
import { runOneEffect } from "../modules/effects/run-effect-worker.js";
import { loadGatewayConfig } from "../config/runtime-config.js";
import { createLogger } from "../observability/logger.js";
import { createHealthServer } from "../shared/health-server.js";
import { sleep, shutdownSignal } from "../shared/process-lifecycle.js";
import { SystemClock } from "../shared/clock.js";
import { createInFlightTracker, requireNoPendingMigrations } from "./app-lifecycle.js";
import { acquireGatewayLease } from "../adapters/postgres/gateway-lease.js";

export function isGatewayMessageInScope(
  message: { guildId: string | null; author: { id: string; bot: boolean } },
  config: { guildId: string; botUserId?: string },
): boolean {
  return message.guildId === config.guildId && message.author.id !== config.botUserId;
}
export interface GatewayDependencies {
  sql: Sql;
  client: Client<true>;
  config: ReturnType<typeof loadGatewayConfig>;
  health: ReturnType<typeof createHealthServer>;
  logger: ReturnType<typeof createLogger>;
  shutdown: Promise<AbortSignal>;
  prepared?: boolean;
  startClient?: () => Promise<void>;
  registerCommands?: () => Promise<void>;
  accepting?: { value: boolean };
  inflight?: ReturnType<typeof createInFlightTracker>;
}

export function registerGatewayListeners(
  client: { on(event: string, listener: (...args: any[]) => void): unknown },
  handlers: { messageCreate: (...args: any[]) => void; interactionCreate: (...args: any[]) => void },
): void {
  client.on("messageCreate", handlers.messageCreate);
  client.on("interactionCreate", handlers.interactionCreate);
}
export async function startGatewayClient(
  client: {
    login(token: string): Promise<unknown>;
    guilds: { fetch(id: string): Promise<{ commands: { set(commands: unknown[]): Promise<unknown> } }> };
  },
  token: string,
  guildId: string,
  command: unknown,
): Promise<void> {
  await client.login(token);
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([command]);
}
export async function cleanupGateway(steps: {
  stop(): void;
  destroy(): Promise<void>;
  drain(): Promise<void>;
  release(): Promise<void>;
  end(): Promise<void>;
}): Promise<void> {
  steps.stop();
  const errors: unknown[] = [];
  for (const action of [() => steps.destroy(), () => steps.drain(), () => steps.release(), () => steps.end()]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Gateway cleanup failed");
}
export function handleGatewayFatal(
  accepting: { value: boolean },
  health: { setReady(ready: boolean): void },
  fatal: (error: unknown) => void,
  error: unknown,
): void {
  accepting.value = false;
  health.setReady(false);
  fatal(error);
}

export async function runGateway(d: GatewayDependencies): Promise<void> {
  const { sql, client, config, health, logger } = d;
  if (!d.prepared) requireNoPendingMigrations(await migrationStatus(sql, config.migrationsDir));
  const capabilities = new PostgresChannelCapabilityRepository(sql);
  const system = new PostgresSystemControlRepository(sql);
  const ingestion = new PostgresIngestionStore(sql);
  const effects = new PostgresEffectQueue(sql);
  const messenger = new DiscordClientMessenger(client, config.guildId);
  const executor = new DiscordEffectExecutor(messenger, effects);
  if (!d.prepared) await effects.recoverExecutingAsUnknown(SystemClock.now());
  const accepting = d.accepting ?? { value: false };
  const inflight = d.inflight ?? createInFlightTracker();
  let rejectFatal!: (error: unknown) => void;
  const fatal = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => undefined);
  const onMessage = (message: Message) => {
    if (
      !accepting.value ||
      !client.user ||
      !isGatewayMessageInScope(message, { guildId: config.guildId, botUserId: client.user.id })
    )
      return;
    const task = (async () => {
      const snapshot = snapshotDiscordMessage(message);
      const input = toDiscordMessageInput(snapshot, client.user!.id);
      const capability = await capabilities.get(config.guildId, input.channelId);
      const mode = await system.get();
      await ingestDiscordMessage(input, capability, mode.mode, ingestion, SystemClock);
    })().catch((error) => {
      handleGatewayFatal(accepting, health, rejectFatal, error);
      logger.error({ err: error }, "Discord ingestion failed");
    });
    inflight.track(task).catch(() => undefined);
  };
  const onInteraction = (interaction: Parameters<NonNullable<Parameters<Client["on"]>[1]>>[0]) => {
    if (
      !accepting.value ||
      !interaction.isChatInputCommand() ||
      interaction.commandName !== channelCommand.name ||
      !interaction.guildId ||
      interaction.guildId !== config.guildId ||
      !interaction.inCachedGuild()
    )
      return;
    const commandRepository = {
      get: capabilities.get.bind(capabilities),
      patch: async (...args: Parameters<typeof capabilities.patch>) => {
        await capabilities.patch(...args);
      },
    };
    inflight
      .track(
        handleChannelCommand(interaction, config.guildId, new Set(config.adminIds), commandRepository, SystemClock),
      )
      .catch((error) => logger.error({ err: error }, "Interaction failed"));
  };
  accepting.value = true;
  registerGatewayListeners(client, { messageCreate: onMessage as never, interactionCreate: onInteraction as never });
  await d.startClient?.();
  await d.registerCommands?.();
  health.setReady(true);
  const controller = new AbortController();
  const effectLoop = runEffectLoop(effects, capabilities, executor, controller.signal, logger, rejectFatal);
  let fatalError: unknown;
  try {
    await Promise.race([d.shutdown, fatal]);
  } catch (error) {
    fatalError = error;
  } finally {
    controller.abort();
    accepting.value = false;
    health.setReady(false);
    await effectLoop;
  }
  if (fatalError !== undefined) throw fatalError;
}
async function runEffectLoop(
  queue: PostgresEffectQueue,
  capabilities: PostgresChannelCapabilityRepository,
  executor: DiscordEffectExecutor,
  signal: AbortSignal,
  logger: ReturnType<typeof createLogger>,
  fatal: (error: unknown) => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      if (!(await runOneEffect(queue, capabilities, executor, "discord-gateway", SystemClock)))
        await sleep(250, signal);
    } catch (error) {
      logger.error({ err: error }, "Effect execution failed");
      fatal(error);
      return;
    }
  }
}
export async function main(env = process.env): Promise<void> {
  const config = loadGatewayConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const health = createHealthServer({ ready: false });
  let sql: Sql | undefined;
  let lease: { release(): Promise<void> } | undefined;
  const accepting = { value: false };
  const inflight = createInFlightTracker();
  let primaryError: unknown;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  try {
    sql = createPostgresClient(config.databaseUrl);
    await health.listen(config.healthPort);
    lease = await acquireGatewayLease(sql);
    requireNoPendingMigrations(await migrationStatus(sql, config.migrationsDir));
    await new PostgresEffectQueue(sql).recoverExecutingAsUnknown(SystemClock.now());
    await runGateway({
      sql,
      client: client as Client<true>,
      config,
      health,
      logger,
      shutdown: shutdownSignal(),
      prepared: true,
      startClient: async () => {
        await client.login(config.discordToken);
      },
      registerCommands: async () => {
        const guild = await client.guilds.fetch(config.guildId);
        await guild.commands.set([channelCommand.toJSON()]);
      },
      accepting,
      inflight,
    });
  } catch (error) {
    primaryError = error;
    logger.error("Discord gateway failed");
    process.exitCode = 1;
  } finally {
    health.setReady(false);
    try {
      await cleanupGateway({
        stop: () => {
          accepting.value = false;
        },
        destroy: () => client.destroy(),
        drain: () => inflight.drain(),
        release: () => lease?.release() ?? Promise.resolve(),
        end: () => sql?.end() ?? Promise.resolve(),
      });
    } catch (error) {
      primaryError = primaryError === undefined ? error : new AggregateError([primaryError, error], "Gateway failed");
    }
    await health.close().catch(() => undefined);
  }
  if (primaryError !== undefined) throw primaryError;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  void main().catch(() => {
    console.error("Discord gateway failed");
    process.exitCode = 1;
  });
```

Do not place pi/provider credentials in the Gateway process environment. The external deployment adapter must provide only `DISCORD_TOKEN` and the Gateway database credential to this process.

`src/apps/discord-gateway.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { cleanupGateway, handleGatewayFatal, registerGatewayListeners, startGatewayClient } from "./discord-gateway.js";

describe("gateway startup helpers", () => {
  it("registers listeners before login and commands after login", async () => {
    const order: string[] = [];
    const client = {
      on: vi.fn((event: string) => {
        order.push(`listener:${event}`);
      }),
      login: vi.fn(async () => {
        order.push("login");
      }),
      guilds: {
        fetch: vi.fn(async () => ({
          commands: {
            set: vi.fn(async () => {
              order.push("commands");
            }),
          },
        })),
      },
    };
    registerGatewayListeners(client as never, { messageCreate: () => undefined, interactionCreate: () => undefined });
    await startGatewayClient(client as never, "token", "guild", {});
    expect(order.slice(0, 2)).toEqual(["listener:messageCreate", "listener:interactionCreate"]);
    expect(order).toContain("login");
    expect(order.at(-1)).toBe("commands");
  });
  it("cleans up in order even when release fails", async () => {
    const order: string[] = [];
    const destroy = vi.fn(async () => {
      order.push("destroy");
    });
    await expect(
      cleanupGateway({
        stop: () => {
          order.push("stop");
        },
        destroy,
        drain: async () => {
          order.push("drain");
        },
        release: async () => {
          order.push("release");
          throw new Error("release");
        },
        end: async () => {
          order.push("end");
        },
      }),
    ).rejects.toThrow("Gateway cleanup failed");
    expect(order).toEqual(["stop", "destroy", "drain", "release", "end"]);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("keeps fatal handling free of fire-and-forget destroy", async () => {
    const fatal = vi.fn();
    const accepting = { value: true };
    const health = { setReady: vi.fn() };
    handleGatewayFatal(accepting, health, fatal, new Error("ingestion"));
    expect(accepting.value).toBe(false);
    expect(health.setReady).toHaveBeenCalledWith(false);
    expect(fatal).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 7: Run process composition tests and build**

Run: `nix develop -c pnpm test && nix develop -c pnpm build`

Expected: all tests PASS and `dist/apps/{admin-cli,cognition-worker,discord-gateway}.js` exist.

- [ ] **Step 8: Record the checkpoint**

Run: `git diff --check && git status --short`

Expected: only Phase 1 files are present; no generated `dist/` files are tracked.

## Task 12: Add the End-to-End Contract, CI, and Operations Guide

**Files:**

- Create: `spec/e2e/mention-response.spec.ts`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-07-23-ai-character-platform-architecture-design.md`

- [x] **Step 1: Write the end-to-end failing specification**

`spec/e2e/mention-response.spec.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Sql } from "postgres";
import { DiscordEffectExecutor } from "../../src/adapters/discord/discord-effect-executor.js";
import { PiAgentRuntime } from "../../src/adapters/pi/pi-agent-runtime.js";
import { PostgresChannelCapabilityRepository } from "../../src/adapters/postgres/channel-capability-repository.js";
import { PostgresCharacterRepository } from "../../src/adapters/postgres/character-repository.js";
import { createPostgresClient } from "../../src/adapters/postgres/client.js";
import { PostgresDecisionEffectStore } from "../../src/adapters/postgres/decision-effect-store.js";
import { PostgresEffectQueue } from "../../src/adapters/postgres/effect-queue.js";
import { PostgresIngestionStore } from "../../src/adapters/postgres/ingestion-store.js";
import { PostgresJobQueue } from "../../src/adapters/postgres/job-queue.js";
import { runMigrations } from "../../src/adapters/postgres/migrations.js";
import { denyAllCapabilities } from "../../src/modules/channels/channel-capability.js";
import { effectNonce } from "../../src/modules/effects/effect.js";
import { ingestDiscordMessage } from "../../src/modules/events/ingest-message.js";
import { processMention } from "../../src/modules/mentions/process-mention.js";
import { FixedClock } from "../../src/shared/clock.js";

let sql: Sql;
const now = new Date("2026-07-23T00:00:00.000Z");
const clock = new FixedClock(now);
const definition = {
  schemaVersion: 1 as const,
  characterId: "primary",
  version: 1,
  name: "テストキャラクター",
  language: "ja" as const,
  systemPrompt: "あなたはDiscordコミュニティで暮らすキャラクターです。",
  failureMessages: ["今ちょっとうまく考えられない。"],
};
const input = {
  externalEventId: "discord-message-1",
  externalVersion: "0",
  guildId: "g",
  channelId: "c",
  threadId: null,
  actorId: "u",
  actorKind: "human" as const,
  occurredAt: now,
  content: "<@bot> こんにちは",
  mentionedBot: true,
  mentionIds: ["bot"],
  replyToMessageId: null,
  attachments: [],
};

beforeAll(async () => {
  sql = createPostgresClient(process.env.TEST_DATABASE_URL!);
});
beforeEach(async () => {
  await runMigrations(sql, process.env.VICISSITUDE_MIGRATIONS_DIR!, {
    actor: "test-bootstrap",
    backupConfirmedAt: new Date(),
  });
  await sql`
    update system_state
    set mode = 'running', updated_at = ${now}, updated_by = 'e2e', reason = 'reset'
    where singleton
  `;
  await sql`truncate audit_entries, effects, model_calls, decision_runs, jobs, events, character_definitions, channel_capabilities cascade`;
  await sql`
    update system_state
    set mode = 'running', updated_at = ${now}, updated_by = 'e2e', reason = 'reset'
    where singleton
  `;
});
afterAll(async () => sql.end());

async function arrange() {
  const capabilities = new PostgresChannelCapabilityRepository(sql);
  await capabilities.set(
    { ...denyAllCapabilities("g", "c"), observeEvents: true, respondToMentions: true },
    "admin",
    "e2e",
    now,
  );
  const characters = new PostgresCharacterRepository(sql);
  await characters.importDraft(definition, "admin", now);
  await characters.activate("primary", 1, "admin", now);
  return capabilities;
}

describe("explicit mention durable spine", () => {
  it("persists, decides, and executes exactly one reply", async () => {
    const capabilities = await arrange();
    const ingestion = new PostgresIngestionStore(sql);
    const capability = await capabilities.get("g", "c");
    const first = await ingestDiscordMessage(input, capability, "running", ingestion, clock);
    const duplicate = await ingestDiscordMessage(input, capability, "running", ingestion, clock);
    expect(first).toMatchObject({ kind: "accepted", duplicate: false, jobQueued: true });
    expect(duplicate).toMatchObject({ kind: "accepted", duplicate: true, jobQueued: false });

    const queue = new PostgresJobQueue(sql);
    const job = await queue.claim("worker", now, 60_000);
    expect(job).not.toBeNull();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("どうしたの？")]);
    await processMention(
      job!,
      definition,
      {
        version: "route-v1",
        mentionResponseDeadlineMs: 25_000,
        mentionResponse: [
          { provider: faux.provider.id, model: faux.getModel().id, thinkingLevel: "off", timeoutMs: 5_000 },
        ],
      },
      new PiAgentRuntime(models),
      new PostgresDecisionEffectStore(sql),
      clock,
    );

    await expect(sql`select state from jobs where id = ${job!.id}`).resolves.toEqual([{ state: "succeeded" }]);
    const counts = await sql<
      Array<{ events: number; jobs: number; runs: number; calls: number; effects: number; audits: number }>
    >`
      select
        (select count(*)::int from events) as events,
        (select count(*)::int from jobs) as jobs,
        (select count(*)::int from decision_runs where state = 'succeeded') as runs,
        (select count(*)::int from model_calls) as calls,
        (select count(*)::int from effects where state = 'planned') as effects,
        (select count(*)::int from audit_entries where category = 'decision.completed') as audits
    `;
    expect(counts[0]).toEqual({ events: 1, jobs: 1, runs: 1, calls: 1, effects: 1, audits: 1 });

    const effectQueue = new PostgresEffectQueue(sql);
    const effect = await effectQueue.claim("gateway", now);
    expect(effect).not.toBeNull();
    const reply = vi.fn().mockResolvedValue({ id: "discord-message-2" });
    await new DiscordEffectExecutor({ reply }, effectQueue).execute(effect!, clock);
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "g", nonce: effectNonce(effect!.id), enforceNonce: true }),
    );
    expect(await effectQueue.get(effect!.id)).toEqual({ state: "succeeded", externalResourceId: "discord-message-2" });
    expect(await queue.claim("worker", now, 60_000)).toBeNull();
    expect(await effectQueue.claim("gateway", now)).toBeNull();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("uses a character fallback without exposing provider errors", async () => {
    const capabilities = await arrange();
    const ingestion = new PostgresIngestionStore(sql);
    await ingestDiscordMessage(input, await capabilities.get("g", "c"), "running", ingestion, clock);
    const queue = new PostgresJobQueue(sql);
    const job = await queue.claim("worker", now, 30_000);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider secret failure" })]);
    await processMention(
      job!,
      definition,
      {
        version: "route-v1",
        mentionResponseDeadlineMs: 25_000,
        mentionResponse: [
          { provider: faux.provider.id, model: faux.getModel().id, thinkingLevel: "off", timeoutMs: 5_000 },
        ],
      },
      new PiAgentRuntime(models),
      new PostgresDecisionEffectStore(sql),
      clock,
    );
    await expect(sql`select state from jobs where id = ${job!.id}`).resolves.toEqual([{ state: "succeeded" }]);
    await expect(queue.claim("worker", now, 60_000)).resolves.toBeNull();
    const effectQueue = new PostgresEffectQueue(sql);
    const effect = await effectQueue.claim("gateway", now);
    expect(effect).not.toBeNull();
    expect(effect!.content).toBe(definition.failureMessages[0]);
    expect(effect!.content).not.toContain("provider");
    const reply = vi.fn().mockResolvedValue({ id: "discord-message-fallback" });
    await new DiscordEffectExecutor({ reply }, effectQueue).execute(effect!, clock);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await effectQueue.get(effect!.id)).toMatchObject({
      state: "succeeded",
      externalResourceId: "discord-message-fallback",
    });
    expect(await effectQueue.claim("gateway", now)).toBeNull();
    const states = await sql<Array<{ job: string; run: string }>>`
      select jobs.state job, decision_runs.state run
      from jobs join decision_runs on decision_runs.job_id = jobs.id
      where jobs.id = ${job!.id}
    `;
    expect(states).toEqual([{ job: "succeeded", run: "succeeded" }]);
    const loggable = await sql<Array<Record<string, unknown>>>`
      select last_error, null::text as decision_error, null::text[] as reason_codes, null::text as model_error, null::text as audit_summary, null::text as effect_error
      from jobs where id = ${job!.id}
      union all
      select null, error, reason_codes, null, null, null from decision_runs where job_id = ${job!.id}
      union all
      select null, null, null, model_calls.error, null, null from model_calls join decision_runs on decision_runs.id = model_calls.run_id where decision_runs.job_id = ${job!.id}
      union all
      select null, null, null, null, summary::text, null from audit_entries where job_id = ${job!.id}
      union all
      select null, null, null, null, null, effects.error from effects join decision_runs on decision_runs.id = effects.run_id where decision_runs.job_id = ${job!.id}
    `;
    expect(JSON.stringify(loggable)).not.toContain("provider secret failure");
  });
});
```

- [x] **Step 2: Run the end-to-end test and verify it fails for any missing composition**

Run: `nix develop -c pnpm test:spec`

Expected before final wiring: FAIL at the first missing application boundary. Resolve discrepancies against the contracts defined in Tasks 3 through 11; do not bypass their public ports.

- [x] **Step 3: Make the end-to-end contract pass**

Run: `nix develop -c pnpm test:spec`

Expected: the normal and model-failure mention paths PASS, with exactly one external Discord call each.

- [x] **Step 4: Add CI with a real PostgreSQL service**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main, develop]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:17.10@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: vicissitude_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/vicissitude_test
      VICISSITUDE_MIGRATIONS_DIR: migrations
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4
        with:
          version: 11.16.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 24.18.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm check
      - run: pnpm test:unit
      - run: pnpm exec vitest run spec
      - run: pnpm build
```

- [x] **Step 5: Write the Phase 1 operations guide**

project-relative label `README.md`:

````markdown
# Vicissitude Phase 1

Phase 1 は、Discord の明示的な mention を PostgreSQL を唯一の真実として受信、判定、効果実行する durable spine です。Gateway、cognition worker、effect worker の境界と lease、deduplication、audit、redaction を含みます。会話クラスタリング、暗黙の宛先推定、memory、autonomy、adaptation は後続フェーズです。

## Prerequisites

Node.js 24、pnpm 11.16、Nix、PostgreSQL 17 が必要です。開発用の全体セットアップとビルド、テストは次のとおりです。

```bash
nix develop
```

上のコマンドで開発 shell に入り、以降のコマンドはその shell で実行します。

```bash
pnpm install
pnpm build
pnpm test
```

`.env.example`は自動ロードされません。環境変数をforeground起動時または外部deployment adapterから明示的に渡してください。

## Initial Setup

```bash
set -euo pipefail
pnpm install
pnpm build
export DATABASE_URL=postgresql://user:password@host:5432/database
export VICISSITUDE_MIGRATIONS_DIR=migrations
export BACKUP_PATH=/var/backups/vicissitude-$(date +%Y%m%d-%H%M%S).dump
pg_dump --format=custom --file "$BACKUP_PATH" "$DATABASE_URL"
pg_restore --list "$BACKUP_PATH" >/dev/null
export BACKUP_CONFIRMED_AT="$(date --iso-8601=seconds --reference="$BACKUP_PATH")"
pnpm admin -- migration status
pnpm admin -- migration apply --backup-confirmed-at "$BACKUP_CONFIRMED_AT" --actor admin-id
pnpm admin -- character import ./character-reviewed.json --actor admin-id
pnpm admin -- character activate primary 1 --actor admin-id
```

`BACKUP_CONFIRMED_AT`は`pg_restore --list`が成功したbackup fileのmtimeを指定します。snapshotを使う場合は、providerが記録したsnapshot完了時刻をoperatorが`export BACKUP_CONFIRMED_AT=...`で設定してください。現在時刻をそのまま指定しないでください。offline rehearsalは`nix build .#checks.x86_64-linux.staging-db-rehearsal`で検証しますが、本番backup artifact自体のrestoreは本番前に別途確認してください。

CharacterDefinition は次の形を満たす JSON を用意します。これは placeholder であり、本番人格ではありません。

```json
{
  "schemaVersion": 1,
  "characterId": "primary",
  "version": 1,
  "name": "レビュー済みキャラクター",
  "language": "ja",
  "systemPrompt": "レビュー済みの system prompt",
  "failureMessages": ["今ちょっとうまく考えられない。"]
}
```

独立レビューで placeholder を本番定義に置き換え、その reviewed file を import、activate してから運用します。

## Operator Environment

各 operator terminal の開始時に、対象 service と同じ値をこの block で設定します。`GUILD_ID` と `CHANNEL_ID` は service から継承されないため、対象を明示してください。health port は Gateway と worker の service 設定と一致させます。

```bash
set -euo pipefail
export DATABASE_URL=postgresql://user:password@host:5432/database
export GUILD_ID=guild-id
export CHANNEL_ID=channel-id
export VICISSITUDE_GATEWAY_HEALTH_PORT=8080
export VICISSITUDE_WORKER_HEALTH_PORT=8081
: "${DATABASE_URL:?replace DATABASE_URL}"
: "${GUILD_ID:?replace GUILD_ID}"
: "${CHANNEL_ID:?replace CHANNEL_ID}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?replace gateway health port}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?replace worker health port}"
```

値は実際の service 設定に置き換え、各 terminal で実行します。

## Go-live

Gateway、worker、operator の3端末を使います。service manager を使う場合は Gateway と cognition worker を別 service として起動します。手動なら terminal 1 で Gateway、terminal 2 で worker を foreground 起動し、terminal 3 を operator 用にします。

```bash
set -euo pipefail
# Operator Environment をこの terminal で設定済みであることを確認する。
: "${DATABASE_URL:?run Operator Environment first}"
: "${GUILD_ID:?run Operator Environment first}"
: "${CHANNEL_ID:?run Operator Environment first}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?run Operator Environment first}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?run Operator Environment first}"
# terminal 3: Gateway と worker は terminal 1、2 または service manager で起動済みとする。
curl --fail http://127.0.0.1:${VICISSITUDE_GATEWAY_HEALTH_PORT}/ready
curl --fail http://127.0.0.1:${VICISSITUDE_WORKER_HEALTH_PORT}/ready
pnpm admin -- channel set "$GUILD_ID" "$CHANNEL_ID" --observe true --mentions true --actor admin-id --reason "enable reviewed target channel"
```

両方の readiness check が成功しなければ channel capability を有効にしません。独立レビュー済みの production CharacterDefinition を import、activate する前に mention capability を有効にしないでください。

## Daily Operations

```bash
set -euo pipefail
# Operator Environment をこの terminal で設定済みであることを確認する。
: "${DATABASE_URL:?run Operator Environment first}"
: "${GUILD_ID:?run Operator Environment first}"
: "${CHANNEL_ID:?run Operator Environment first}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?run Operator Environment first}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?run Operator Environment first}"
pnpm admin -- system drain --actor admin-id --reason "deploy"
while true; do
  active="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT (SELECT count(*) FROM jobs WHERE state = 'running') + (SELECT count(*) FROM effects WHERE state IN ('planned', 'executing'));")" || {
    printf '%s\n' "failed to query active leases" >&2
    exit 1
  }
  case "$active" in
    0) break ;;
    ''|*[!0-9]*)
      printf 'invalid active lease count: %s\n' "$active" >&2
      exit 1
      ;;
  esac
  sleep 5
done
# Stop Gateway and cognition worker with the service manager used by this deployment.
# Do not stop either process while the count is non-zero.
# If the count does not clear because a worker crashed or a lease expired, do not stop processes or migrate.
# Investigate first. Unknown effects are handled separately below.
pnpm build
export BACKUP_PATH=/var/backups/vicissitude-$(date +%Y%m%d-%H%M%S).dump
pg_dump --format=custom --file "$BACKUP_PATH" "$DATABASE_URL"
pg_restore --list "$BACKUP_PATH" >/dev/null
export BACKUP_CONFIRMED_AT="$(date --iso-8601=seconds --reference="$BACKUP_PATH")"
pnpm admin -- migration status
pnpm admin -- migration apply --backup-confirmed-at "$BACKUP_CONFIRMED_AT" --actor admin-id
```

上の block が成功終了するまで deploy を続けません。migration 後、service manager で Gateway と cognition worker の両方を起動します。手動運用では Go-live と同じく、次の二つを別 terminal で実行します。

```bash
set -euo pipefail
pnpm start:gateway
```

terminal 1 で Gateway を foreground 起動します。

```bash
set -euo pipefail
pnpm start:worker
```

terminal 2 で cognition worker を foreground 起動します。operator は terminal 3 で次を実行します。

```bash
set -euo pipefail
curl --fail http://127.0.0.1:${VICISSITUDE_GATEWAY_HEALTH_PORT}/ready
curl --fail http://127.0.0.1:${VICISSITUDE_WORKER_HEALTH_PORT}/ready
pnpm admin -- system resume --actor admin-id --reason "deploy complete"
```

両方の readiness check が成功しなければ resume や mentions enable を実行しません。

`system drain` は新しい job claim だけを止め、effect claim は止めず、すぐに戻ります。in-flight または完了済み job が作った planned effect は drain 中も claim、実行されます。上の count が 0 になるまで Gateway と cognition worker を停止しないでください。この手順で effect pipeline も drain します。0 にならない場合は強制停止せず、running job、planned または executing effect、stale lease を調べます。期限切れ lease は fencing の対象ですが、外部 effect が実行済みか不明になると recovery の確認が必要です。

```bash
set -euo pipefail
: "${DATABASE_URL:?run Operator Environment first}"
pnpm admin -- effect inspect effect-id
pnpm admin -- effect reconcile effect-id --state succeeded --external-resource-id discord-message-id --actor admin-id --reason "verified in Discord"
```

Unknown effects are not retried automatically. Discover them with their target and update fields:

```bash
set -euo pipefail
: "${DATABASE_URL:?run Operator Environment first}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT id, run_id, guild_id, capability_channel_id, target_channel_id, target_message_id, updated_at FROM effects WHERE state = 'unknown' ORDER BY updated_at;"
```

Run `pnpm admin -- effect inspect effect-id` for each ID. After checking Discord, reconcile a confirmed message with `--state succeeded --external-resource-id discord-message-id`, or reconcile a proven absence with `--state failed` and no external resource ID. If the outcome is uncertain, leave the effect `unknown`. Never auto retry an unknown effect.

## Discord Setup

Guilds、Guild Messages、Message Content intents を有効にします。`VICISSITUDE_GUILD_ID` は対象を単一 guild に限定し、`VICISSITUDE_ADMIN_USER_IDS` は管理者 allowlist をカンマ区切りで指定します。DM は対象外です。Gateway は singleton として動かします。

## Model Setup

`config/model-routes.example.json` を `VICISSITUDE_MODEL_ROUTES_PATH` が指す場所へコピーします。provider credentials は `@earendil-works/pi-ai` の環境変数を使い、`cognition-worker` にだけ渡します。`discord-gateway` には渡しません。

## Database Changes

起動時にmigrationは実行しません。直近24時間以内に作成し、`pg_restore --list`で確認したbackupまたはsnapshotの完了時刻を`BACKUP_CONFIRMED_AT`に渡します。`audit_entries`と適用済みmigration versionを確認します。offline rehearsalの成功とは別に、本番backup artifactのrestoreを本番前に確認してください。

## Health

長時間プロセスは localhost の設定ポートで `GET /live` と `GET /ready` を公開します。`/live` はプロセス生存を返します。Gateway の `/ready` は DB migration preflight、system singleton と recovery、Discord login、command registration の完了を確認します。Gateway は production CharacterDefinition を確認しません。Worker の `/ready` は migration、production CharacterDefinition、model routes の起動 preflight が完了した時点で true になります。iteration が失敗すると false に戻り、次に成功した iteration で true に戻ります。`draining` と `stopped` は readiness を直接変えず、job claim を止めます。`/health` は使用しません。

## Credential Boundary

Nix packageはprocess managerやsecret配布方式を固定しません。外部deployment adapterはprocessごとに別のcredential setを使い、共有setを作りません。Gatewayの設定契約は`DATABASE_URL`、`DISCORD_TOKEN`、`VICISSITUDE_GUILD_ID`、`VICISSITUDE_ADMIN_USER_IDS`、`VICISSITUDE_GATEWAY_HEALTH_PORT`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Gatewayにprovider credentialを渡しません。Workerの設定契約は`DATABASE_URL`、選択したprovider credential、`VICISSITUDE_WORKER_ID`、`VICISSITUDE_WORKER_HEALTH_PORT`、`VICISSITUDE_CHARACTER_ID`、`VICISSITUDE_MODEL_ROUTES_PATH`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Workerに`DISCORD_TOKEN`を渡しません。message content、prompt、response、token、connection string、providerのraw errorはログに出しません。

## Effect Recovery

外部呼び出し後に状態が不明な effect は自動 retry しません。Discord に存在すると確認できた場合だけ succeeded と external resource ID を付け、存在しないと確認できた場合だけ failed と external resource ID なしで reconcile します。結果が不明なら `unknown` のままにします。

## Shutdown And Drain

`system drain` は新しい job claim だけを止め、effect claim は止めません。実行中 lease を待つ機能もありません。停止前に PostgreSQL の running job と planned または executing effect が 0 になるまで待ち、この手順で effect pipeline を drain します。0 にならない場合は強制停止せず、原因を調べます。期限切れ lease は fencing の対象です。外部 effect の実行結果が不明な場合は、Discord 側を確認してから reconcile します。

## Lease Recovery

単一 guild、単一 channel の deploy で running job が消えない場合は、channel capability を変更せず、同じ worker を復旧します。planned または executing effect の処理中に capability を変えると `capability_revoked` になるためです。`GUILD_ID` と `CHANNEL_ID` は対象を固定し、別 channel を巻き込みません。別の admin が recovery 中に別 channel を enable しない、という排他運用が必要です。scope の安全性は変数ではなく、下の DB assertions で確認します。

```bash
set -euo pipefail
export GUILD_ID=guild-id
export CHANNEL_ID=channel-id
: "${DATABASE_URL:?run Operator Environment first}"
: "${GUILD_ID:?replace GUILD_ID}"
: "${CHANNEL_ID:?replace CHANNEL_ID}"
violations="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v guild_id="$GUILD_ID" -v channel_id="$CHANNEL_ID" -Atc "SELECT (SELECT count(*) FROM channel_capabilities WHERE respond_to_mentions AND NOT (guild_id = :'guild_id' AND channel_id = :'channel_id')) + (SELECT count(*) FROM jobs j JOIN events e ON e.id = j.event_id WHERE j.state IN ('queued', 'running') AND NOT (e.guild_id = :'guild_id' AND e.channel_id = :'channel_id')) + (SELECT count(*) FROM effects WHERE state IN ('planned', 'executing') AND NOT (guild_id = :'guild_id' AND capability_channel_id = :'channel_id'));" )" || {
  printf '%s\n' "failed to verify recovery scope" >&2
  exit 1
}
case "$violations" in
  0) ;;
  ''|*[!0-9]*)
    printf 'invalid recovery scope violation count: %s\n' "$violations" >&2
    exit 1
    ;;
  *)
    printf 'recovery scope has %s violations; do not resume\n' "$violations" >&2
    exit 1
    ;;
esac
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v guild_id="$GUILD_ID" -v channel_id="$CHANNEL_ID" -Atc "SELECT j.id, j.event_id, j.lease_owner, j.leased_until FROM jobs j JOIN events e ON e.id = j.event_id WHERE j.state = 'running' AND e.guild_id = :'guild_id' AND e.channel_id = :'channel_id' ORDER BY j.leased_until NULLS FIRST;"
# 同じ build の cognition worker を再起動する。service manager または別 terminal を使う。
while true; do
  active="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM jobs WHERE state = 'running' AND leased_until > clock_timestamp();")" || {
    printf '%s\n' "failed to query lease expiry" >&2
    exit 1
  }
  case "$active" in
    0) break ;;
    ''|*[!0-9]*)
      printf 'invalid unexpired lease count: %s\n' "$active" >&2
      exit 1
      ;;
  esac
  sleep 5
done
pnpm admin -- system resume --actor admin-id --reason "allow worker reclaim"
while true; do
  active="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM jobs WHERE state = 'running' AND (leased_until IS NULL OR leased_until <= clock_timestamp());")" || {
    printf '%s\n' "failed to query recovery state" >&2
    exit 1
  }
  case "$active" in
    0) break ;;
    ''|*[!0-9]*)
      printf 'invalid recovery count: %s\n' "$active" >&2
      exit 1
      ;;
  esac
  sleep 5
done
pnpm admin -- system drain --actor admin-id --reason "prepare deploy after recovery"
while true; do
  active="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT (SELECT count(*) FROM jobs WHERE state = 'running') + (SELECT count(*) FROM effects WHERE state IN ('planned', 'executing'));")" || {
    printf '%s\n' "failed to query active pipeline" >&2
    exit 1
  }
  case "$active" in
    0) break ;;
    ''|*[!0-9]*)
      printf 'invalid active pipeline count: %s\n' "$active" >&2
      exit 1
      ;;
  esac
  sleep 5
done
```

queued job は deploy 後に処理できるため、drain-to-zero の count には含めません。active count が消えない場合は強制停止や migration をせず、原因を調べます。capability は recovery 中も変更しません。unknown effect は active drain count に含めず、Discord の結果を確認して別途 reconcile します。recovery と deploy が終わり、再起動後の readiness が成功してから `system resume`、最後に mentions enable を実行します。

## Production Go-Live

production persona はリポジトリに同梱しません。運用者が独立レビューした CharacterDefinition を import、activate し、対象 channel の mention capability を有効化してから Discord reply を有効にします。

## Tests And Layout

CI は format、lint、型検査、unit、実 PostgreSQL の `spec`、build を実行します。外部 credential と provider network は不要です。主要ディレクトリは `src/apps`、`src/modules`、`src/adapters`、`migrations`、`spec`、`config` です。
````

This file is the Phase 1 operations guide.

- [x] **Step 6: Update architecture implementation status**

After all Step 7 commands pass, add this section to the architecture spec:

```markdown
## Implementation Status

- Phase 1 Task1-13: implementation complete; automated unit tests, real PostgreSQL E2E, deterministic lease-expiry/run-creation race and Gateway `system_state` singleton preflight coverage, flake, and build checks pass
- Implementation plan: `docs/superpowers/plans/2026-07-23-phase-1-durable-spine.md`
- Not verified: backup restore rehearsal, live Discord/provider credential deployment, and production CharacterDefinition go-live
- Production go-live gate: an independently reviewed production CharacterDefinition must be imported and activated before enabling Discord replies
- Deferred behavior: conversation clustering, implicit addressee inference, memory, autonomy, and adaptation remain assigned to later phases
```

- [x] **Step 7: Run final verification**

Run:

```bash
nix develop -c pnpm format
nix develop -c pnpm validate
nix develop -c pnpm build
nix flake check
git diff --check
```

Expected:

- Unit, PostgreSQL contract, and end-to-end tests PASS.
- Type checking, lint, formatting, build, and flake checks PASS.
- No live Discord or provider credentials are required by tests.
- `git status --short` contains only intended source, config, migration, test, documentation, lockfile, and workflow files.

- [ ] **Step 8: Request review before production credentials are configured**

Present:

- Test and build evidence
- Schema migration status
- Requirement coverage for Phase 1
- Known deferred Phase 2 behavior
- CharacterDefinition go-live gate
- Files requiring secrets at deployment time

## Task 13: Resolve cross-cutting durability review findings

**Files:**

- Modify: `src/modules/events/ingest-message.ts`
- Modify: `spec/modules/events/ingest-message.spec.ts`
- Modify: `src/modules/mentions/process-mention.ts`
- Modify: `src/modules/mentions/process-mention.test.ts`
- Modify: `src/adapters/postgres/decision-effect-store.ts`
- Modify: `spec/adapters/postgres/decision-effect-store.spec.ts`
- Modify: `src/adapters/postgres/job-queue.ts`
- Modify: `spec/adapters/postgres/job-queue.spec.ts`
- Modify: `src/apps/discord-gateway.ts`
- Create: `spec/apps/discord-gateway.spec.ts`

This final delta records the completed TDD fixes for the cross-cutting review findings. The red tests covered five failures: an eligible mention during draining was not queued; a stale or expired lease could create a run; an exhausted job could leave a running decision and no audit; one late `startOrLoadRun` could race exhausted-job cleanup into inconsistent durable state; and Gateway startup could report ready before validating the `system_state` singleton.

The final contracts are:

- Queueing applies only to a response-eligible human explicit mention (`mentionedBot` and `respondToMentions`) while the system is running or draining. A stopped system persists the event according to channel capability but does not enqueue a job.
- `startOrLoadRun` accepts `leaseToken` and validates the lease under a row lock before creating or loading the run:

```ts
return this.sql.begin(async (tx) => {
  const jobs = await tx<Array<{ event_id: string }>>
    `select event_id from jobs where id = ${input.jobId} and state = 'running' and lease_token = ${input.leaseToken} and leased_until > ${input.now} for update`;
  if (!jobs[0] || jobs[0].event_id !== input.eventId) throw new Error("Lease lost");
```

The row lock, matching state/token/time predicates, and `eventId` validation are part of the run-creation contract.

- Exhausted-job cleanup uses separate fresh statements and row locks, fencing the job and its run independently and writing an audit entry for both a run and a null-run exhaustion path.
- The late-race regression test uses competing `startOrLoadRun` and cleanup operations with independent database clients plus a third advisory blocker transaction. Both operations complete; cleanup waits for the job lock, then fails the same run/job and writes the linked audit entry. The test does not rely on timing sleeps or claim two transactions created two runs.
- Gateway startup validates the `system_state` singleton before listener registration, Discord login, command registration, or readiness. A real PostgreSQL regression test removes the singleton and verifies that none of those side effects occur before startup fails.

The lease check remains a start-time fence, not a claim that model execution is covered: a valid lease may expire after the pre-model check. The terminal effect/job transition is fenced, while full lease renewal and cancellation remain later hardening.

Verification: unit 128; real PostgreSQL spec 61, including E2E; `validate`; `build`; `flake`; and `git diff --check` all PASS.

Do not commit, push, deploy, migrate production, or configure live credentials unless the user explicitly requests it.
