# Minecraft 固有コードの mcp→minecraft 移譲 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Minecraft 専用のブリッジ／メモリツール実装を `mcp` パッケージから `minecraft` パッケージへ移し、重複している `MINECRAFT_AGENT_ID` を `@vicissitude/shared/namespace` に単一ソース化し、誤配置された minecraft spec を `spec/minecraft/` へ集約する。

**Architecture:** 依存方向は現状 `minecraft → mcp`（`result`/`tool-metrics`/`http-server` 等の汎用 MCP インフラ）。Minecraft 側でしか使われない `mc-bridge-minecraft` / `mc-memory` / `event-helpers` / `memory-helpers` を `minecraft` へ移すことで mcp 側から minecraft 固有コードを排除する。Discord 側 delegate ツール（`mc-bridge-discord`）は discord MCP サーバー（`mcp/src/discord-server.ts`）が登録するため mcp に残す（移動すると `mcp → minecraft` の循環になる）。共有定数 `MINECRAFT_AGENT_ID` は両側＋agent が参照するため、全員が依存し循環しない `@vicissitude/shared/namespace` に置く。

**Tech Stack:** Bun, TypeScript, zod v4, `@modelcontextprotocol/sdk`。テストは `*.spec.ts`（公開契約）。検証は `nr validate`（fmt:check + lint + check）と `nr test`。

**前提（調査済みの事実）:**

- `MINECRAFT_AGENT_ID = "minecraft:brain"` は `packages/mcp/src/tools/mc-bridge-constants.ts` と `packages/minecraft/src/constants.ts` に**重複定義**。agent パッケージは `@vicissitude/minecraft/constants` 側を使用中。
- `mc-bridge-constants.ts` は mcp の package.json exports に**含まれない**（相対 import のみ）。
- `event-helpers.ts` は packages 内で `mc-bridge-minecraft.ts` のみが使用。`memory-helpers.ts` は `mc-memory.ts` のみが使用。両者とも mcp 内の他モジュールに依存しない（fs/shared のみ）。
- `mc-bridge-minecraft.ts` / `mc-memory.ts` は `./result.ts`（mcp の汎用ヘルパ。`textContent`/`errorContent`/`resolveBoundScope`）を使う → 移動後は `@vicissitude/mcp/tools/result` から import（正当な minecraft→mcp 方向）。
- `spec/mcp/minecraft/*`（22 spec + `stub-logger.ts` + `reactive-layer-helpers.ts` + `actions/` サブツリー）は **minecraft パッケージの spec が誤配置**されたもの。中身は `@vicissitude/minecraft/*` エイリアスと `./relative` ヘルパしか参照しないため、ファイル移動だけで import 変更不要。
- `spec/mcp/tools/mc-bridge-http.spec.ts` は discord 側 `registerDiscordBridgeTools`（mcp 残置）をテストするので **spec/mcp に残す**。ただし `../minecraft/stub-logger.ts` を参照しているため、stub-logger 移動後にパス修正が必要。

**移動後の最終ファイル名（minecraft パッケージ内）:**
| 移動元 (mcp) | 移動先 (minecraft) |
| --- | --- |
| `src/tools/mc-bridge-minecraft.ts` | `src/mc-bridge-tools.ts` |
| `src/tools/mc-memory.ts` | `src/mc-memory.ts` |
| `src/tools/event-helpers.ts` | `src/event-helpers.ts` |
| `src/memory-helpers.ts` | `src/memory-helpers.ts` |

エクスポート名は不変: `registerMinecraftBridgeTools` / `formatCommands` / `registerMcMemoryTools` / `MAX_BATCH_SIZE` / `parseEvents` / `isErrorEvent` / `escapeUserMessageTag` / `ParsedEvent` / `ErrorEvent` / `EventOrError` / `readWithFallbackFrom` / `ensureDir` / `createBackup` 他。

---

## Task 1: `MINECRAFT_AGENT_ID` を `@vicissitude/shared/namespace` に単一ソース化

**Files:**

- Modify: `packages/shared/src/namespace.ts`（定数追加）
- Modify: `packages/minecraft/src/constants.ts`（重複定義を削除）
- Delete: `packages/mcp/src/tools/mc-bridge-constants.ts`
- Modify: `packages/mcp/src/tools/mc-bridge-minecraft.ts:15`（import 元変更）
- Modify: `packages/mcp/src/tools/mc-bridge-discord.ts:11`（import 元変更）
- Modify: `packages/agent/src/minecraft/minecraft-agent.ts:1`（import 元変更）
- Modify: `packages/agent/src/minecraft/brain-manager.ts:4`（import 元変更）
- Modify: `spec/mcp/tools/mc-bridge-integration.spec.ts:6`（import 元変更）

- [ ] **Step 1: shared/namespace に定数を追加**

`packages/shared/src/namespace.ts` の `GUILD_ID_RE` 定義の直後（`agentScopeNamespace` 関数の前）に追加:

```ts
/** Minecraft エージェントの agentId。minecraft brain の単一ルーティングキー。 */
export const MINECRAFT_AGENT_ID = "minecraft:brain";
```

- [ ] **Step 2: minecraft/constants.ts から重複定義を削除**

`packages/minecraft/src/constants.ts` の以下 2 行（コメント + 定数）を削除する:

```ts
/** Minecraft エージェントの agentId */
export const MINECRAFT_AGENT_ID = "minecraft:brain";
```

（`McAuthMode` 関連はそのまま残す。`import { z } from "zod";` も残す。）

- [ ] **Step 3: mcp の重複定数ファイルを削除し、参照元を付け替え**

```bash
git rm packages/mcp/src/tools/mc-bridge-constants.ts
```

`packages/mcp/src/tools/mc-bridge-minecraft.ts` の import 行（15行目付近）:

```ts
// before
import { MINECRAFT_AGENT_ID } from "./mc-bridge-constants.ts";
// after
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/namespace";
```

`packages/mcp/src/tools/mc-bridge-discord.ts` の import 行（11行目付近）:

```ts
// before
import { MINECRAFT_AGENT_ID } from "./mc-bridge-constants.ts";
// after
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/namespace";
```

- [ ] **Step 4: agent 側の参照を付け替え**

`packages/agent/src/minecraft/minecraft-agent.ts:1` と `packages/agent/src/minecraft/brain-manager.ts:4`:

```ts
// before
import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
// after
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/namespace";
```

- [ ] **Step 5: spec の参照を付け替え**

`spec/mcp/tools/mc-bridge-integration.spec.ts:6`:

```ts
// before
import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
// after
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/namespace";
```

- [ ] **Step 6: 取りこぼし確認**

Run: `rg -n "mc-bridge-constants|from \"@vicissitude/minecraft/constants\"" packages/ spec/`
Expected: `@vicissitude/minecraft/constants` の残存は `McAuthMode`/`parseMcAuthMode` を import している箇所のみ（`MINECRAFT_AGENT_ID` を含む行は 0 件）。`mc-bridge-constants` への参照は 0 件。

- [ ] **Step 7: フォーマットと検証**

Run: `nr fmt && nr validate`
Expected: 0 error。

- [ ] **Step 8: 関連テスト実行**

Run: `nr test`
Expected: 全 pass（移動はまだ無く、定数の出所だけが変わっている）。

- [ ] **Step 9: コミット**

```bash
git add -A
git commit -m "refactor(shared): MINECRAFT_AGENT_ID を namespace に単一ソース化する"
```

---

## Task 2: Minecraft 側ブリッジ／メモリツールを minecraft パッケージへ移動

**Files:**

- Move: `packages/mcp/src/tools/mc-bridge-minecraft.ts` → `packages/minecraft/src/mc-bridge-tools.ts`
- Move: `packages/mcp/src/tools/mc-memory.ts` → `packages/minecraft/src/mc-memory.ts`
- Move: `packages/mcp/src/tools/event-helpers.ts` → `packages/minecraft/src/event-helpers.ts`
- Move: `packages/mcp/src/memory-helpers.ts` → `packages/minecraft/src/memory-helpers.ts`
- Modify: `packages/minecraft/src/mc-bridge-server.ts`（import を相対パスへ）
- Modify: `packages/minecraft/package.json`（exports 追加）
- Modify: `packages/mcp/package.json`（exports 削除）

- [ ] **Step 1: 4 ファイルを git mv で移動**

```bash
git mv packages/mcp/src/tools/mc-bridge-minecraft.ts packages/minecraft/src/mc-bridge-tools.ts
git mv packages/mcp/src/tools/mc-memory.ts packages/minecraft/src/mc-memory.ts
git mv packages/mcp/src/tools/event-helpers.ts packages/minecraft/src/event-helpers.ts
git mv packages/mcp/src/memory-helpers.ts packages/minecraft/src/memory-helpers.ts
```

- [ ] **Step 2: `mc-bridge-tools.ts` の import を修正**

`packages/minecraft/src/mc-bridge-tools.ts` の import 群を次に変更（`result.ts` のみクロスパッケージ化。`event-helpers.ts` は同階層になったので相対のまま、`MINECRAFT_AGENT_ID` は Task 1 で shared 参照済み）:

```ts
// before
import { errorContent, textContent } from "./result.ts";
// after
import { errorContent, textContent } from "@vicissitude/mcp/tools/result";
```

`./event-helpers.ts` と `@vicissitude/shared/...`、`@vicissitude/store/...` の import 行は変更不要。

- [ ] **Step 3: `mc-memory.ts` の import を修正**

`packages/minecraft/src/mc-memory.ts`:

```ts
// before
import { createBackup, ensureDir, readWithFallbackFrom } from "../memory-helpers.ts";
import { errorContent, textContent } from "./result.ts";
// after
import { errorContent, textContent } from "@vicissitude/mcp/tools/result";
import { createBackup, ensureDir, readWithFallbackFrom } from "./memory-helpers.ts";
```

（`event-helpers.ts` と `memory-helpers.ts` は外部 import を持たない＝変更不要。）

- [ ] **Step 4: `mc-bridge-server.ts` の import を相対パスへ**

`packages/minecraft/src/mc-bridge-server.ts:5-6`:

```ts
// before
import { registerMinecraftBridgeTools } from "@vicissitude/mcp/tools/mc-bridge-minecraft";
import { registerMcMemoryTools } from "@vicissitude/mcp/tools/mc-memory";
// after
import { registerMinecraftBridgeTools } from "./mc-bridge-tools.ts";
import { registerMcMemoryTools } from "./mc-memory.ts";
```

- [ ] **Step 5: minecraft/package.json に exports を追加**

`packages/minecraft/package.json` の `"exports"` に以下 4 行を追加（`"./constants"` の後など適当な位置）:

```json
		"./mc-bridge-tools": "./src/mc-bridge-tools.ts",
		"./mc-memory": "./src/mc-memory.ts",
		"./event-helpers": "./src/event-helpers.ts",
		"./memory-helpers": "./src/memory-helpers.ts",
```

- [ ] **Step 6: mcp/package.json から exports を削除**

`packages/mcp/package.json` の `"exports"` から以下 4 エントリを削除する:

```json
		"./memory-helpers": "./src/memory-helpers.ts",
		"./tools/event-helpers": "./src/tools/event-helpers.ts",
		"./tools/mc-bridge-minecraft": "./src/tools/mc-bridge-minecraft.ts",
		"./tools/mc-memory": "./src/tools/mc-memory.ts",
```

（`"./tools/mc-bridge-discord"` / `"./tools/result"` / `"./tool-metrics"` / `"./http-server"` は**残す**。）

- [ ] **Step 7: 取りこぼし確認**

Run: `rg -n "mcp/tools/mc-bridge-minecraft|mcp/tools/mc-memory|mcp/tools/event-helpers|mcp/memory-helpers" packages/`
Expected: 0 件（packages 配下に残存参照なし。spec の更新は Task 3）。

- [ ] **Step 8: フォーマットと型検査**

Run: `nr fmt && nr validate`
Expected: 0 error。（この時点で `spec/mcp/tools/*` や `spec/mcp/memory-helpers.spec.ts` はまだ旧パスを参照するため `nr test` は赤になり得る。型検査 `nr check` がワークスペース横断で spec も見る場合は Task 3 とまとめてコミットする必要がある点に注意 → 次ステップ参照。）

- [ ] **Step 9: spec 由来の型エラーが出る場合は Task 3 と統合**

Run: `nr check`

- spec の旧 import に起因する型エラーが出る場合、Task 2 と Task 3 を**1 コミットに統合**する（spec を直してから一括 commit）。その場合 Step 10 のコミットはスキップし、Task 3 完了後にまとめてコミットする。
- 型エラーが出ない（spec が緩く解決される）場合のみ Step 10 を実行。

- [ ] **Step 10: コミット（Step 9 で統合不要だった場合のみ）**

```bash
git add -A
git commit -m "refactor(minecraft): ブリッジ／メモリツールを mcp から minecraft へ移譲する"
```

---

## Task 3: 誤配置された minecraft spec を `spec/minecraft/` へ集約

**Files:**

- Move: `spec/mcp/minecraft/` ツリー全体 → `spec/minecraft/`（22 spec + `stub-logger.ts` + `reactive-layer-helpers.ts` + `actions/` サブツリー）
- Move + Modify: `spec/mcp/tools/mc-bridge-integration.spec.ts` → `spec/minecraft/mc-bridge-integration.spec.ts`
- Move + Modify: `spec/mcp/tools/mc-bridge-format-commands.spec.ts` → `spec/minecraft/mc-bridge-format-commands.spec.ts`
- Move + Modify: `spec/mcp/tools/mc-memory.spec.ts` → `spec/minecraft/mc-memory.spec.ts`
- Move + Modify: `spec/mcp/memory-helpers.spec.ts` → `spec/minecraft/memory-helpers.spec.ts`
- Modify: `spec/mcp/tools/mc-bridge-http.spec.ts`（stub-logger の相対パスのみ修正、ファイルは spec/mcp に残す）

- [ ] **Step 1: minecraft パッケージ spec ツリーを丸ごと移動**

```bash
git mv spec/mcp/minecraft spec/minecraft
```

（22 spec + `stub-logger.ts` + `reactive-layer-helpers.ts` + `actions/` を含む。中身は `@vicissitude/minecraft/*` と `./` 相対参照のみのため import 編集不要。）

- [ ] **Step 2: minecraft 側ブリッジ／メモリ spec を移動**

```bash
git mv spec/mcp/tools/mc-bridge-integration.spec.ts spec/minecraft/mc-bridge-integration.spec.ts
git mv spec/mcp/tools/mc-bridge-format-commands.spec.ts spec/minecraft/mc-bridge-format-commands.spec.ts
git mv spec/mcp/tools/mc-memory.spec.ts spec/minecraft/mc-memory.spec.ts
git mv spec/mcp/memory-helpers.spec.ts spec/minecraft/memory-helpers.spec.ts
```

- [ ] **Step 3: 移動した spec の import を新パッケージへ付け替え**

`spec/minecraft/mc-bridge-integration.spec.ts`:

```ts
// before
import { MAX_BATCH_SIZE } from "@vicissitude/mcp/tools/event-helpers";
import { registerMinecraftBridgeTools } from "@vicissitude/mcp/tools/mc-bridge-minecraft";
// after
import { MAX_BATCH_SIZE } from "@vicissitude/minecraft/event-helpers";
import { registerMinecraftBridgeTools } from "@vicissitude/minecraft/mc-bridge-tools";
```

`spec/minecraft/mc-bridge-format-commands.spec.ts`:

```ts
// before
import type { ErrorEvent, ParsedEvent } from "@vicissitude/mcp/tools/event-helpers";
import { formatCommands } from "@vicissitude/mcp/tools/mc-bridge-minecraft";
// after
import type { ErrorEvent, ParsedEvent } from "@vicissitude/minecraft/event-helpers";
import { formatCommands } from "@vicissitude/minecraft/mc-bridge-tools";
```

`spec/minecraft/mc-memory.spec.ts`（12行目付近の import 元）:

```ts
// before
} from "@vicissitude/mcp/tools/mc-memory";
// after
} from "@vicissitude/minecraft/mc-memory";
```

`spec/minecraft/memory-helpers.spec.ts:5`:

```ts
// before
import { readWithFallbackFrom } from "@vicissitude/mcp/memory-helpers";
// after
import { readWithFallbackFrom } from "@vicissitude/minecraft/memory-helpers";
```

- [ ] **Step 4: spec/mcp に残す mc-bridge-http.spec.ts の stub-logger パスを修正**

`spec/mcp/tools/mc-bridge-http.spec.ts:10`:

```ts
// before
import { stubLogger } from "../minecraft/stub-logger.ts";
// after
import { stubLogger } from "../../minecraft/stub-logger.ts";
```

（このファイルは discord 側 `registerDiscordBridgeTools` をテストするため spec/mcp に残す。）

- [ ] **Step 5: 取りこぼし確認**

Run: `rg -n "@vicissitude/mcp/tools/(mc-bridge-minecraft|mc-memory|event-helpers)|@vicissitude/mcp/memory-helpers" spec/`
Expected: 0 件。

Run: `rg -n "stub-logger" spec/ && ls spec/mcp/minecraft 2>/dev/null || echo "spec/mcp/minecraft removed: OK"`
Expected: `stub-logger` 参照は `spec/minecraft/` 配下（同階層 `./`）と `spec/mcp/tools/mc-bridge-http.spec.ts`（`../../minecraft/`）のみ。`spec/mcp/minecraft` ディレクトリは消えている。

- [ ] **Step 6: フォーマットと全検証**

Run: `nr fmt && nr validate && nr test`
Expected: `nr validate` 0 error、`nr test` 全 pass。

- [ ] **Step 7: コミット**

Task 2 Step 9 で統合した場合はここで一括コミット:

```bash
git add -A
git commit -m "refactor(minecraft): ブリッジ／メモリツールとその spec を minecraft へ移譲する"
```

Task 2 を独立コミット済みの場合は spec 移動のみをコミット:

```bash
git add -A
git commit -m "test(minecraft): 誤配置された minecraft spec を spec/minecraft へ集約する"
```

---

## 最終検証（全タスク完了後）

- [ ] **Step 1: 全検証をクリーンに通す**

Run: `nr fmt && nr validate && nr test`
Expected: fmt:check / lint / check すべて 0 error、テスト全 pass。出力を PR 説明に貼る（完了宣言ルール）。

- [ ] **Step 2: 依存方向の最終確認**

Run: `rg -n "@vicissitude/minecraft" packages/mcp/src && echo "WARN: mcp depends on minecraft (cycle!)" || echo "OK: no mcp->minecraft import"`
Expected: `OK: no mcp->minecraft import`（mcp は minecraft に依存しない＝循環なし）。

- [ ] **Step 3: PR 作成**

```bash
git push -u origin <branch>
gh pr create --title "refactor(minecraft): Minecraft 固有コードを mcp から minecraft へ移譲する" --body "<検証結果を含む説明>"
```

PR 本文に Phase 2 ロードマップ項目「Minecraft 固有コードの mcp→minecraft 移譲」完了である旨と、`nr validate`/`nr test` の実行結果を記載する。

---

## スコープ外（必要なら Issue 化）

- `mc-bridge-discord.ts`（discord 側 delegate ツール）は mcp に残置。これを minecraft へ寄せるには discord MCP サーバー構成自体の再設計が必要で、本 PR の循環回避方針と矛盾するため対象外。
- `memory-helpers.ts` は汎用 fs ヘルパだが現状唯一の利用者が minecraft のため minecraft へ移動した。将来他パッケージが必要とする場合は `@vicissitude/shared` への昇格を検討。
