# Staging Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部credentialを使わず、Phase 1 packageとPostgreSQL durability境界を再現可能なNix checkとして固定する。

**Architecture:** 配布単位はsupervisor非依存のNix packageだけとし、Gateway、worker、adminの3 executableを提供する。database rehearsalはNix sandbox内の3つのPostgreSQL 17 clusterをUnix socketだけで起動し、migration前backupとpopulated backupを別clusterへrestoreする。実運用のprocess起動、secret配布、environment/process isolationはdeployment adapterの責務とし、このcheckへ含めない。

**Tech Stack:** Nix flakes、Node.js 24、pnpm 11、PostgreSQL 17、Bash、SQL、Vitest、GitHub Actions。

---

## Task 1: Self-contained Nix package

**Files:**

- `nix/package.nix`
- `flake.nix`

- [x] `packages.<system>.default`をx86_64-linux、aarch64-linux、aarch64-darwinへ公開する。
- [x] `vicissitude-gateway`、`vicissitude-worker`、`vicissitude-admin` appを公開する。
- [x] package sourceを`lib.fileset.gitTracked`に限定する。
- [x] pnpm dependency hashを`sha256-ROaLBdp08Bl4p6hns6u6l5t4wJROECCLxBFvkZcs9us=`へ固定する。
- [x] store内のmigrationとmodel routeをwrapperの上書き可能な既定値にする。
- [x] production dependencyだけをruntime outputへ残す。
- [x] pnpmの揮発性metadataを除去し、`--rebuild`の出力比較を成功させる。
- [x] package build中に3 app entrypointのproduction import contractを検査する。

Verification:

```bash
nix build --no-link .#default
nix build --no-link .#default --rebuild
nix eval .#packages.aarch64-linux.default.pname
nix eval .#packages.aarch64-darwin.default.pname
```

Commits: `0cf5824`、`ebb3cd6`、`eaa7892`、`2ef93c4`、`d1ec3a1`。

## Task 2: PostgreSQL Unix socket boundary

**Files:**

- `src/adapters/postgres/client.ts`
- `src/adapters/postgres/client.test.ts`

- [x] percent-encoded Unix socket authorityをsocket pathへ変換するtestをREDで追加する。
- [x] socket、port、database、userをpostgres.js optionへ正しく渡す。
- [x] passwordと`sslmode`など、socket/port以外のURL情報を保持する。

Verification:

```bash
nix develop -c pnpm exec vitest run src/adapters/postgres/client.test.ts
```

Commits: `10108cb`、`d987009`。

## Task 3: Three-cluster database rehearsal

**Files:**

- `nix/db-rehearsal.sh`
- `nix/db-rehearsal.nix`
- `nix/sql/runtime-acl.sql`
- `nix/sql/fixture.sql`
- `nix/sql/privilege-matrix.sql`
- `nix/sql/catalog-assertions.sql`
- `src/staging/db-rehearsal-contract.test.ts`
- `flake.nix`

- [x] contract testを先に追加し、driver、SQL、flake outputがないREDを確認する。
- [x] source、migration-before-restore、populated-restoreを別data/socket directoryで起動する。
- [x] 全clusterへ同じ3 roleを`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`で作成する。
- [x] migration適用前の空databaseをcustom-formatでdumpし、別clusterへ`--create --exit-on-error`でrestoreする。
- [x] dump mtime由来のUTC timestampをpackaged admin executableへ渡してmigrationを適用する。
- [x] migration後にruntime ACLを別SQLで適用し、`0001` migrationを変更しない。
- [x] deterministic fixtureとpositive probe用のevent/jobを投入する。
- [x] Gateway/workerと全table/全operationの実効権限を期待matrixと比較する。
- [x] 許可された各operationをruntime roleの実statementで実行する。
- [x] 禁止されたtable操作、DDL、role変更、migration変更がSQLSTATE 42501になることを確認する。
- [x] role属性、membership、PUBLIC revoke、database/schema/table owner、default ACLを検査する。
- [x] sourceとpopulated restoreのowner/ACL snapshotを比較する。
- [x] 7 index、PK/unique/check/FK constraint、fixture/audit linkageを検査する。
- [x] dump SHA-256、integer mtime、contents list、migration checksum、`backupConfirmedAt`を一時manifestと照合する。
- [x] Nix outputを`result` fileの一行`staging-db-rehearsal: PASS`だけにする。
- [x] failure outputをcheck、role、operation、expectedだけに制限する。

Verification:

```bash
nix develop -c pnpm exec vitest run src/staging/db-rehearsal-contract.test.ts
bash -n nix/db-rehearsal.sh
nix build .#checks.x86_64-linux.staging-db-rehearsal
test "$(cat result/result)" = 'staging-db-rehearsal: PASS'
test "$(wc -l < result/result)" -eq 1
```

Commits: `fb21e4e`、`d987009`。

## Task 4: CI and documentation

**Files:**

- `.github/workflows/ci.yml`
- `README.md`
- `docs/superpowers/specs/2026-07-23-ai-character-platform-architecture-design.md`
- `docs/superpowers/specs/2026-07-25-staging-validation-design.md`
- `docs/superpowers/plans/2026-07-25-staging-validation.md`

- [x] 既存quality jobを変更せず、pinned Nix installerを使う`staging-validation` jobを追加する。
- [x] staging jobではpackageとdatabase checkだけをbuildする。
- [x] READMEから特定process manager前提を除去し、executableごとのcredential contractへ置き換える。
- [x] offline verifiedとproduction/live unverifiedをREADMEとarchitectureへ反映する。
- [x] staging specを`Implemented and verified offline`へ更新する。
- [x] active planを実装済みfile、check、commitに同期する。

Verification:

```bash
nix run nixpkgs#actionlint -- .github/workflows/ci.yml
git diff --check
```

## Task 5: Final verification

- [x] focused contract testsを実行する。
- [x] unit 133件、real PostgreSQL spec/E2E 61件、format、lint、typecheck、buildを実行する。
- [x] package、database rehearsal、flake checkを実行する。
- [x] actionlintと文書のsupervisor非依存性を確認する。
- [x] migration `0001`が不変であることを確認する。
- [x] final code/spec reviewを完了する。
- [ ] commit、push後にGitHub Actionsを確認する。

Commands:

```bash
nix develop -c pnpm validate
nix develop -c pnpm build
nix build --no-link .#default
nix build .#checks.x86_64-linux.staging-db-rehearsal
nix flake check
nix run nixpkgs#actionlint -- .github/workflows/ci.yml
git diff --check
```
