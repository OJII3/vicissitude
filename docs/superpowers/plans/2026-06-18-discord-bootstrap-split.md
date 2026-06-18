# Discord bootstrap 分割 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/discord/src/bootstrap.ts`（1071 行）を責務ごとの `bootstrap/` サブモジュール群へ分割し、`bootstrap.ts` を `bootstrap()` エントリのみの薄いファイルにする。

**Architecture:** 純粋な機械的抽出リファクタ。関数本体は **逐語的に移動**（ロジック変更なし）。依存は一方向 DAG（`environment` ← `agents`、その他は独立、すべて `bootstrap.ts` が集約）。公開契約は既存の `*.spec.ts` が担保し、リファクタ campaign の方針（「spec 書き換え前提」）に従い spec / unit test の **import パスとファイル配置のみ** を新モジュール構造へ追従させる。挙動アサーションは一切変更しない。

**Tech Stack:** Bun, TypeScript, oxlint/oxfmt, bun:test。検証は `nr` 経由（`nr validate` / `nr test:spec` / `nr test:unit`）。

---

## File Structure

新規ディレクトリ `apps/discord/src/bootstrap/` を作り、以下へ抽出する。括弧内は現 `bootstrap.ts` の行範囲（抽出元）。

| 新モジュール                    | 含む関数 / 型                                                                                                                                                                              | 抽出元行               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `bootstrap/layers.ts`           | `createStoreLayer`, `createContextLayer`, `createWebContextLayer`, `createFileSessionSummaryWriter`                                                                                        | 96–151                 |
| `bootstrap/environment.ts`      | `buildCoreEnvironment`, `buildDiscordEnvironment`, `prepareOpencodeShellAgentDirectory`, `buildOpencodeShellAgentEnvironment`, `discordOpencodeSkillPaths`, `buildAgentDiscordEnvironment` | 152–247                |
| `bootstrap/agents.ts`           | `DiscordAgentSpec`(型), `createConversationAgentSpecs`, `createHeartbeatAgentSpecs`, `isHeartbeatAgentId`, `canUseShellAgent`, `createDiscordAgents`, `createWebConversationAgent`         | 248–424                |
| `bootstrap/metrics.ts`          | `createMetrics`                                                                                                                                                                            | 425–466                |
| `bootstrap/channel-config.ts`   | `loadChannelConfig`                                                                                                                                                                        | 467–483                |
| `bootstrap/memory-recording.ts` | `buildCriticAuditorAdapter`, `setupMemoryRecording`                                                                                                                                        | 484–596                |
| `bootstrap/event-handlers.ts`   | `setupEventHandlers`                                                                                                                                                                       | 597–702                |
| `bootstrap/minecraft-mcp.ts`    | `waitForMcpReady`, `startMinecraftMcp`                                                                                                                                                     | 703–772                |
| `bootstrap/runtime.ts`          | `startSessionGauge`, `resolveBootstrapRoot`, `buildEmailCheckPreFilter`                                                                                                                    | 773–820                |
| `bootstrap.ts`（残置）          | `bootstrap()` のみ + 新モジュールからの import                                                                                                                                             | 1–95(import), 821–1071 |

**モジュール間依存（import 方向）:**

- `bootstrap/agents.ts` → `bootstrap/environment.ts`（`createDiscordAgents` が `buildAgentDiscordEnvironment` / `buildOpencodeShellAgentEnvironment` / `prepareOpencodeShellAgentDirectory` / `discordOpencodeSkillPaths` を内部利用）
- 他モジュールは相互依存なし。`bootstrap.ts` が全モジュールを import。
- `createFileSessionSummaryWriter`（現 private）は `bootstrap()` から使うため **export 化**。

**テスト配置（規約: spec は src 構造をミラー、unit は co-locate）:**

| 新テストファイル                                  | 対象                                                                                | 元ファイル / 行                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `spec/discord/bootstrap/environment.spec.ts`      | `buildAgentDiscordEnvironment` / `buildCoreEnvironment` / `buildDiscordEnvironment` | `spec/discord/bootstrap.spec.ts` の該当 describe        |
| `spec/discord/bootstrap/runtime.spec.ts`          | `buildEmailCheckPreFilter`                                                          | `spec/discord/bootstrap.spec.ts` の該当 describe        |
| `spec/discord/bootstrap/memory-recording.spec.ts` | `buildCriticAuditorAdapter` / `setupMemoryRecording`                                | `spec/discord/bootstrap-memory.spec.ts`（全体リネーム） |
| `apps/discord/src/bootstrap/layers.test.ts`       | `createStoreLayer` / `createContextLayer` / `createWebContextLayer`                 | `bootstrap.test.ts` 66–75, 107–186                      |
| `apps/discord/src/bootstrap/metrics.test.ts`      | `createMetrics`                                                                     | `bootstrap.test.ts` 76–85                               |
| `apps/discord/src/bootstrap/agents.test.ts`       | `createDiscordAgents` / `createWebConversationAgent`                                | `bootstrap.test.ts` 187–649, 761–788                    |
| `apps/discord/src/bootstrap/runtime.test.ts`      | `resolveBootstrapRoot` / `buildEmailCheckPreFilter`                                 | `bootstrap.test.ts` 86–106, 650–760                     |

> 旧 `spec/discord/bootstrap.spec.ts`・`spec/discord/bootstrap-memory.spec.ts`・`apps/discord/src/bootstrap.test.ts` は分割後に削除する。

---

## 共通ルール（全タスク共通）

- **関数本体は逐語コピー**。空白・コメント・ロジックを変えない。差分は「ファイル移動」「import 行の追加/削除」「private→export の修飾子変更（`createFileSessionSummaryWriter` のみ）」だけ。
- 各新モジュール冒頭に、その関数群が必要とする import だけを移植する（`bootstrap.ts` 1–93 の import から該当分を抜き出す）。未使用 import は持ち込まない（`nr lint` が落ちる）。
- 各タスク末尾で必ず該当テストを実行し green を確認してからコミット。`type(scope): 日本語要約` の Conventional Commits。
- 作業ブランチ `refactor/discord-bootstrap-split` を切ってから着手（main 直 push 禁止）。

---

## Task 0: ブランチ作成

- [ ] **Step 1: 作業ブランチを切る**

```bash
git switch -c refactor/discord-bootstrap-split
```

- [ ] **Step 2: ディレクトリ作成**

```bash
mkdir -p apps/discord/src/bootstrap spec/discord/bootstrap
```

---

## Task 1: layers.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/layers.ts`
- Create: `apps/discord/src/bootstrap/layers.test.ts`
- Modify: `apps/discord/src/bootstrap.ts`
- Delete (後続タスクで段階的に縮小): なし

- [ ] **Step 1: `layers.ts` を作成**

`bootstrap.ts` 96–151 の 4 関数（`createStoreLayer`, `createContextLayer`, `createWebContextLayer`, `createFileSessionSummaryWriter`）を逐語移動。`createFileSessionSummaryWriter` の `function` を `export function` に変更。冒頭 import はこれらが使うもののみ移植する。必要 import（実体を確認しつつ移植）:

```ts
import { resolve } from "path";

import { ContextBuilder, type ContextFileName } from "@vicissitude/agent/discord/context-builder";
import { createConversationProfile } from "@vicissitude/agent/discord/profile";
import { createWebConversationProfile } from "@vicissitude/agent/web/profile";
import type {
	ContextBuilderPort,
	MemoryFactReader,
	SessionStorePort,
	SessionSummaryWriter,
} from "@vicissitude/shared/types";
import type { StoreDb } from "@vicissitude/store/db";
import { createDb } from "@vicissitude/store/db";
import { createSqliteSessionStore } from "@vicissitude/store/session-store";

import { type AppConfig } from "../config.ts";
```

> 実際に必要な識別子は移動した関数本体を読んで確定すること（上記は想定。`nr check` で過不足を検出）。

- [ ] **Step 2: `bootstrap.ts` から 4 関数を削除し import 追加**

`bootstrap.ts` 96–151 を削除。先頭の import 群に追加:

```ts
import {
	createContextLayer,
	createFileSessionSummaryWriter,
	createStoreLayer,
	createWebContextLayer,
} from "./bootstrap/layers.ts";
```

`bootstrap.ts` 内で不要になった import（例: `createDb`, `createSqliteSessionStore`, `ContextBuilder` など layers.ts 専用だったもの）を削除。`bootstrap()` 本体で `db`/`StoreDb`/`closeDb` をまだ使うものは残す。

- [ ] **Step 3: 型チェックで import 過不足を検出**

Run: `nr check`
Expected: PASS（落ちたら未使用/不足 import を修正）

- [ ] **Step 4: unit test を移動**

`apps/discord/src/bootstrap/layers.test.ts` を作成。`bootstrap.test.ts` の `describe("createStoreLayer"...)`(66–75) と `describe("createContextLayer"...)`(107–186) を移植。import を `from "./layers.ts"` に変更（`createStoreLayer`, `createContextLayer`, `createWebContextLayer`）。他の必要 import（`AppConfig` は `../config.ts`、test-helpers 等）も合わせる。元 `bootstrap.test.ts` からは該当 describe を削除。

- [ ] **Step 5: テスト実行**

Run: `nr test:unit -- apps/discord/src/bootstrap/layers.test.ts`
Expected: PASS（移動前と同じアサーションが全 green）

- [ ] **Step 6: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/layers.ts apps/discord/src/bootstrap/layers.test.ts apps/discord/src/bootstrap.ts apps/discord/src/bootstrap.test.ts
git commit -m "refactor(discord): bootstrap の store/context レイヤ生成を layers.ts へ分離する"
```

---

## Task 2: environment.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/environment.ts`
- Create: `spec/discord/bootstrap/environment.spec.ts`
- Modify: `apps/discord/src/bootstrap.ts`, `spec/discord/bootstrap.spec.ts`

- [ ] **Step 1: `environment.ts` を作成**

`bootstrap.ts` 152–247 の 6 関数（`buildCoreEnvironment`, `buildDiscordEnvironment`, `prepareOpencodeShellAgentDirectory`, `buildOpencodeShellAgentEnvironment`, `discordOpencodeSkillPaths`, `buildAgentDiscordEnvironment`）を逐語移動。export 修飾子は現状維持（`buildCoreEnvironment`/`buildDiscordEnvironment`/`buildAgentDiscordEnvironment` は export、残り 3 は private のまま — ただし `agents.ts` が使う 4 関数 = `buildAgentDiscordEnvironment`/`buildOpencodeShellAgentEnvironment`/`prepareOpencodeShellAgentDirectory`/`discordOpencodeSkillPaths` は **export 化**する）。必要 import を移植（`fs`, `path`, `@vicissitude/shared/github-auth-env`, `@vicissitude/shared/workspace-gitconfig`, `@vicissitude/agent/mcp-config`, `../config.ts` 等。本体を読んで確定）。

- [ ] **Step 2: `bootstrap.ts` から 6 関数削除し import 追加**

```ts
import {
	buildAgentDiscordEnvironment,
	buildCoreEnvironment,
	buildDiscordEnvironment,
} from "./bootstrap/environment.ts";
```

> `bootstrap()` が直接使うのは `buildCoreEnvironment` / `buildDiscordEnvironment` のみ。`buildAgentDiscordEnvironment` 等は `agents.ts` 経由なので bootstrap.ts では不要なら入れない。不要になった env 専用 import を削除。

- [ ] **Step 3: 型チェック**

Run: `nr check`
Expected: PASS

- [ ] **Step 4: spec を分割移動**

`spec/discord/bootstrap/environment.spec.ts` を作成。旧 `spec/discord/bootstrap.spec.ts` の `buildAgentDiscordEnvironment` / `buildCoreEnvironment` / `buildDiscordEnvironment` に関する describe を移植。import を `from "../../../apps/discord/src/bootstrap/environment.ts"` に変更（相対階層が 1 段深くなる点に注意）。`AppConfig` は `from "../../../apps/discord/src/config.ts"`。旧 `bootstrap.spec.ts` からは該当 describe を削除（残るのは `buildEmailCheckPreFilter` のみ → Task 9 で runtime.spec.ts へ）。

- [ ] **Step 5: spec 実行**

Run: `nr test:spec -- spec/discord/bootstrap/environment.spec.ts`
Expected: PASS

- [ ] **Step 6: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/environment.ts spec/discord/bootstrap/environment.spec.ts apps/discord/src/bootstrap.ts spec/discord/bootstrap.spec.ts
git commit -m "refactor(discord): bootstrap の MCP/OpenCode 環境変数構築を environment.ts へ分離する"
```

---

## Task 3: agents.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/agents.ts`
- Create: `apps/discord/src/bootstrap/agents.test.ts`
- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: `agents.ts` を作成**

`bootstrap.ts` 248–424 の型 `DiscordAgentSpec` と関数群（`createConversationAgentSpecs`, `createHeartbeatAgentSpecs`, `isHeartbeatAgentId`, `canUseShellAgent`, `createDiscordAgents`, `createWebConversationAgent`）を逐語移動。`isHeartbeatAgentId` / `canUseShellAgent` は private 維持。環境構築 4 関数は `environment.ts` から import:

```ts
import {
	buildAgentDiscordEnvironment,
	buildOpencodeShellAgentEnvironment,
	discordOpencodeSkillPaths,
	prepareOpencodeShellAgentDirectory,
} from "./environment.ts";
```

その他 `DiscordAgent`, `WebConversationAgent`, `WEB_AGENT_ID`, `WEB_SCOPE_ID`, opencode constants, `../config.ts` 等の必要 import を移植。

- [ ] **Step 2: `bootstrap.ts` から該当削除し import 追加**

```ts
import {
	createConversationAgentSpecs,
	createDiscordAgents,
	createHeartbeatAgentSpecs,
	createWebConversationAgent,
	type DiscordAgentSpec,
} from "./bootstrap/agents.ts";
```

不要になった agent 系 import を削除。

- [ ] **Step 3: 型チェック**

Run: `nr check`
Expected: PASS

- [ ] **Step 4: unit test 移動**

`apps/discord/src/bootstrap/agents.test.ts` を作成。`bootstrap.test.ts` の `describe("createDiscordAgents"...)`(187–649) と `describe("createWebConversationAgent"...)`(761–788) を移植。import を `from "./agents.ts"`。元 `bootstrap.test.ts` から削除。

- [ ] **Step 5: テスト実行**

Run: `nr test:unit -- apps/discord/src/bootstrap/agents.test.ts`
Expected: PASS

- [ ] **Step 6: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/agents.ts apps/discord/src/bootstrap/agents.test.ts apps/discord/src/bootstrap.ts apps/discord/src/bootstrap.test.ts
git commit -m "refactor(discord): bootstrap の agent 生成ロジックを agents.ts へ分離する"
```

---

## Task 4: metrics.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/metrics.ts`
- Create: `apps/discord/src/bootstrap/metrics.test.ts`
- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: `metrics.ts` を作成**

`bootstrap.ts` 425–466 の `createMetrics` を逐語移動。必要 import（`@vicissitude/observability/metrics` の `PrometheusCollector`/`PrometheusServer`/`METRIC`、`Logger` 型等）を移植。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import { createMetrics } from "./bootstrap/metrics.ts";
```

不要になった metrics import を削除。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

- [ ] **Step 4: unit test 移動**

`apps/discord/src/bootstrap/metrics.test.ts` を作成。`bootstrap.test.ts` の `describe("createMetrics"...)`(76–85) を移植、import を `from "./metrics.ts"`。元から削除。

- [ ] **Step 5: テスト実行**

Run: `nr test:unit -- apps/discord/src/bootstrap/metrics.test.ts`
Expected: PASS

- [ ] **Step 6: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/metrics.ts apps/discord/src/bootstrap/metrics.test.ts apps/discord/src/bootstrap.ts apps/discord/src/bootstrap.test.ts
git commit -m "refactor(discord): bootstrap の Prometheus メトリクス生成を metrics.ts へ分離する"
```

---

## Task 5: channel-config.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/channel-config.ts`
- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: `channel-config.ts` を作成**

`bootstrap.ts` 467–483 の `loadChannelConfig` を逐語移動。`ChannelConfigLoader`/`ChannelConfigData` は `../gateway/channel-config-loader.ts` から import。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import { loadChannelConfig } from "./bootstrap/channel-config.ts";
```

`ChannelConfigLoader` import が bootstrap.ts で不要になれば削除（`channelConfig` 変数の型推論で残る可能性あり → `nr check` で判定）。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

> `loadChannelConfig` に専用 unit/spec は無い（grep 済み）。テスト移動なし。

- [ ] **Step 4: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/channel-config.ts apps/discord/src/bootstrap.ts
git commit -m "refactor(discord): bootstrap の channel config ロードを channel-config.ts へ分離する"
```

---

## Task 6: memory-recording.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/memory-recording.ts`
- Create: `spec/discord/bootstrap/memory-recording.spec.ts`
- Modify: `apps/discord/src/bootstrap.ts`
- Delete: `spec/discord/bootstrap-memory.spec.ts`

- [ ] **Step 1: `memory-recording.ts` を作成**

`bootstrap.ts` 484–596 の `buildCriticAuditorAdapter`, `setupMemoryRecording` を逐語移動。memory 系 import（`CriticAuditor`, `MemoryChatAdapter`, `CompositeLLMAdapter`, `MemoryConversationRecorder`, `DriftScoreCalculator`, `MemoryStorage`, `MemoryLlmPort`, namespace 群, `ConsolidationScheduler`, `MemoryStorage`, `GitHubIssueAdapter`, `CriticAuditorPort` 等）を移植。本体を読んで確定。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import { setupMemoryRecording } from "./bootstrap/memory-recording.ts";
```

> `buildCriticAuditorAdapter` は `setupMemoryRecording` 内部からのみ呼ばれる（grep 済み 566 行）が、spec が直接 import するため **export 維持**。bootstrap.ts は `setupMemoryRecording` のみ使用。不要になった memory import を bootstrap.ts から削除。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

- [ ] **Step 4: spec をリネーム移動**

`spec/discord/bootstrap/memory-recording.spec.ts` を作成（旧 `spec/discord/bootstrap-memory.spec.ts` の内容全体）。bootstrap import を `from "../../../apps/discord/src/bootstrap/memory-recording.ts"` に変更、`AppConfig` を `from "../../../apps/discord/src/config.ts"` に変更（階層 1 段深化）。旧 `spec/discord/bootstrap-memory.spec.ts` を削除。

```bash
git rm spec/discord/bootstrap-memory.spec.ts
```

- [ ] **Step 5: spec 実行**

Run: `nr test:spec -- spec/discord/bootstrap/memory-recording.spec.ts`
Expected: PASS

- [ ] **Step 6: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/memory-recording.ts spec/discord/bootstrap/memory-recording.spec.ts apps/discord/src/bootstrap.ts
git add -u spec/discord/
git commit -m "refactor(discord): bootstrap の memory 記録セットアップを memory-recording.ts へ分離する"
```

---

## Task 7: event-handlers.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/event-handlers.ts`
- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: `event-handlers.ts` を作成**

`bootstrap.ts` 597–702 の `setupEventHandlers` を逐語移動。必要 import（`DiscordGateway`, `MessageIngestionService`, `GuildRouter` / `AiAgent`, `MetricsCollector`, `Logger`, `formatDiscordMessage`, `ImageAttachmentDescriber` 等。本体を読んで確定）を移植。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import { setupEventHandlers } from "./bootstrap/event-handlers.ts";
```

不要 import を削除。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

> `setupEventHandlers` に専用 spec/unit は無い。テスト移動なし。

- [ ] **Step 4: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/event-handlers.ts apps/discord/src/bootstrap.ts
git commit -m "refactor(discord): bootstrap の gateway イベントハンドラ配線を event-handlers.ts へ分離する"
```

---

## Task 8: minecraft-mcp.ts 抽出

**Files:**

- Create: `apps/discord/src/bootstrap/minecraft-mcp.ts`
- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: `minecraft-mcp.ts` を作成**

`bootstrap.ts` 703–772 の `waitForMcpReady`, `startMinecraftMcp` を逐語移動。`waitForMcpReady` は private 維持（`startMinecraftMcp` 内部利用、grep 済み 755 行）、`startMinecraftMcp` を export。必要 import（`bun` の `spawn`/`Subprocess`, `Logger`, `../config.ts`, `path` 等）を移植。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import { startMinecraftMcp } from "./bootstrap/minecraft-mcp.ts";
```

不要 import 削除。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

> 専用 spec/unit 無し。

- [ ] **Step 4: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/minecraft-mcp.ts apps/discord/src/bootstrap.ts
git commit -m "refactor(discord): bootstrap の Minecraft MCP 起動を minecraft-mcp.ts へ分離する"
```

---

## Task 9: runtime.ts 抽出 + 旧テスト削除

**Files:**

- Create: `apps/discord/src/bootstrap/runtime.ts`
- Create: `apps/discord/src/bootstrap/runtime.test.ts`
- Create: `spec/discord/bootstrap/runtime.spec.ts`
- Modify: `apps/discord/src/bootstrap.ts`
- Delete: `apps/discord/src/bootstrap.test.ts`, `spec/discord/bootstrap.spec.ts`

- [ ] **Step 1: `runtime.ts` を作成**

`bootstrap.ts` 773–820 の `startSessionGauge`, `resolveBootstrapRoot`, `buildEmailCheckPreFilter` を逐語移動。必要 import（`SessionStorePort`, `MetricsCollector`, `METRIC`, `fetchNewEmails`/`formatEmailContext`, `PreFilterResult`, `DueReminder`, `Logger`, `../config.ts` 等。本体を読んで確定）を移植。

- [ ] **Step 2: `bootstrap.ts` から削除し import 追加**

```ts
import {
	buildEmailCheckPreFilter,
	resolveBootstrapRoot,
	startSessionGauge,
} from "./bootstrap/runtime.ts";
```

不要 import を削除。この時点で `bootstrap.ts` は import 群 + `bootstrap()` のみ（~280 行）になっているはず。

- [ ] **Step 3: 型チェック** — Run: `nr check` / Expected: PASS

- [ ] **Step 4: unit test 移動**

`apps/discord/src/bootstrap/runtime.test.ts` を作成。`bootstrap.test.ts` 残存の `describe("resolveBootstrapRoot"...)`(86–106) と `describe("buildEmailCheckPreFilter 内部分岐"...)`(650–760) を移植。import を `from "./runtime.ts"`。

- [ ] **Step 5: spec 移動**

`spec/discord/bootstrap/runtime.spec.ts` を作成。旧 `spec/discord/bootstrap.spec.ts` 残存の `buildEmailCheckPreFilter` describe を移植。import を `from "../../../apps/discord/src/bootstrap/runtime.ts"`、`AppConfig` を `from "../../../apps/discord/src/config.ts"`。

- [ ] **Step 6: 旧テストファイル削除**

この時点で `apps/discord/src/bootstrap.test.ts` と `spec/discord/bootstrap.spec.ts` は全 describe を移し終え空（import のみ）になっているはず。削除する。

```bash
git rm apps/discord/src/bootstrap.test.ts spec/discord/bootstrap.spec.ts
```

- [ ] **Step 7: テスト実行**

Run: `nr test:unit -- apps/discord/src/bootstrap/runtime.test.ts` then `nr test:spec -- spec/discord/bootstrap/runtime.spec.ts`
Expected: 両方 PASS

- [ ] **Step 8: fmt & commit**

```bash
nr fmt
git add apps/discord/src/bootstrap/runtime.ts apps/discord/src/bootstrap/runtime.test.ts spec/discord/bootstrap/runtime.spec.ts apps/discord/src/bootstrap.ts
git add -u apps/discord/src/ spec/discord/
git commit -m "refactor(discord): bootstrap のランタイムヘルパを runtime.ts へ分離し旧テストを再配置する"
```

---

## Task 10: oxlint disable コメント整理

**Files:**

- Modify: `apps/discord/src/bootstrap.ts`

- [ ] **Step 1: 行頭の lint disable を見直す**

`bootstrap.ts` 1 行目 `/* oxlint-disable max-dependencies, max-lines -- ... */` は分割で行数・依存が減るため不要になる可能性が高い。削除して `nr lint` を実行し、まだ閾値超過なら **必要な分だけ** 残す（`max-dependencies` は import 数次第）。

- [ ] **Step 2: lint 確認**

Run: `nr lint`
Expected: PASS（disable 削除後も警告ゼロ。残す場合は最小限）

- [ ] **Step 3: commit**

```bash
nr fmt
git add apps/discord/src/bootstrap.ts
git commit -m "refactor(discord): 分割で不要になった bootstrap の lint disable を整理する"
```

---

## Task 11: 全体検証

- [ ] **Step 1: fmt 適用**

Run: `nr fmt`

- [ ] **Step 2: validate（fmt:check + lint + check 一括）**

Run: `nr validate`
Expected: 全 PASS

- [ ] **Step 3: 全テスト**

Run: `nr test`
Expected: 全 PASS（移動した spec/unit が新パスで green、削除した旧ファイルへの dangling import が無い）

- [ ] **Step 4: bootstrap.ts 行数確認**

Run: `wc -l apps/discord/src/bootstrap.ts`
Expected: ~280 行前後（1071 → 大幅減）

- [ ] **Step 5: push & PR**

```bash
git push -u origin refactor/discord-bootstrap-split
gh pr create --fill
```

---

## Self-Review

**1. Spec coverage:** 公開契約（`buildAgentDiscordEnvironment`/`buildCoreEnvironment`/`buildDiscordEnvironment` → Task 2、`buildEmailCheckPreFilter` → Task 9、`buildCriticAuditorAdapter`/`setupMemoryRecording` → Task 6）は全て新 spec へ追従済み。`index.ts` の `bootstrap` import は不変（Task で触れない）。

**2. Placeholder scan:** 各タスクの import リストは「本体を読んで確定」と明示。これは TBD ではなく「逐語移動なので機械的に決まる」ことを示す指示。`nr check` が過不足を必ず検出するためフォールバック不要。

**3. Type consistency:** モジュール名・関数名は File Structure 表と各タスクで一致。`environment.ts` で export 化する 4 関数（`buildAgentDiscordEnvironment`/`buildOpencodeShellAgentEnvironment`/`prepareOpencodeShellAgentDirectory`/`discordOpencodeSkillPaths`）と `agents.ts` の import が整合。`createFileSessionSummaryWriter` の export 化（Task 1）と `bootstrap()` での利用が整合。

**4. リスク:** 純粋なファイル移動のため live SQLite マイグレーションへの影響なし（store スキーマ不変）。最大リスクは import 過不足だが各タスクの `nr check` ゲートで吸収。
