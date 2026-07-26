# README Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** README を Vicissitude の恒久的な入口として再構成し、既存の運用手順と安全条件を保ったまま Phase 1 の作業記録らしさをなくす。

**Architecture:** `README.md` 内で、プロジェクト概要、開発、実行構成、初期構築、運用、復旧、設定リファレンスを読者の目的順に並べる。運用コマンドのコードブロックは変更せずに移動し、重複する説明だけを統合する。

**Tech Stack:** Markdown、Git、Node.js 24、ripgrep

---

## File Structure

- Modify: `README.md` - プロジェクト概要、開発手順、運用 runbook、設定リファレンス
- Reference only: `docs/superpowers/specs/2026-07-26-readme-reorganization-design.md` - 承認済みの構成と非対象範囲

新しい運用文書や検証スクリプトは追加しない。

### Task 1: プロジェクト概要と情報構造を恒久化する

**Files:**

- Modify: `README.md:1-295`
- Reference: `docs/superpowers/specs/2026-07-26-readme-reorganization-design.md`

- [ ] **Step 1: 現在のタイトルが新しい要件を満たさないことを確認する**

Run:

```bash
test "$(rg -m1 '^# ' README.md)" = '# Vicissitude'
```

Expected: FAIL。現在の先頭見出しは `# Vicissitude Phase 1`。

- [ ] **Step 2: タイトル、概要、Development、Architecture を書き換える**

`README.md` の冒頭を次の内容にする。既存の `Prerequisites` にある2つのコマンドブロックは `Development` の本文中へそのまま移動する。

```markdown
# Vicissitude

Vicissitude は、Discord コミュニティ内で継続的に動作する AI キャラクター基盤です。

現在の実装は、Discord の明示的な mention を PostgreSQL を唯一の真実として受信し、応答を判断して Discord へ返す durable spine を提供します。受信、判断、外部作用を別の状態として永続化し、lease、deduplication、audit、redaction によって障害時も処理を追跡できる構成です。

## Development

Node.js 24、pnpm 11.16、Nix、PostgreSQL 17 が必要です。開発 shell に入り、依存関係の取得、build、test を実行します。
```

Development のコマンドブロックの後へ、次の節を置く。

```markdown
`.env.example` は自動ロードされません。各 executable に必要な環境変数だけを、foreground 起動時または外部 deployment adapter から明示的に渡してください。このリポジトリは process manager や secret 配布方式を固定しません。

## Architecture

PostgreSQL が event、job、decision、effect、character definition、channel capability、audit entry の正本です。実行単位は次の3つです。

- `discord-gateway`: Discord event の受信と永続化、管理 command の受付、永続化済み Discord effect の実行を担当します。Discord token を持つ唯一の process です。
- `cognition-worker`: job を claim し、production CharacterDefinition と model route を使って mention への応答を判断し、effect を永続化します。
- `admin-cli`: migration、CharacterDefinition、channel capability、drain、effect recovery を操作します。

Gateway と cognition worker は別 process として動かします。provider credential は cognition worker だけに、Discord token は Gateway だけに渡します。
```

将来フェーズの機能一覧は削除する。現在の実装範囲は上記の概要だけで説明し、プロジェクト名や見出しに `Phase 1` を残さない。

- [ ] **Step 3: 運用 runbook を役割別の階層へ並べ替える**

トップレベル見出しと既存内容を次の順序にする。

| 最終見出し | 収める既存内容 |
| --- | --- |
| `## Initial Setup` | `Initial Setup` の backup、migration、CharacterDefinition 登録手順 |
| `## Operations` | 運用開始、通常 deploy、production go-live |
| `### Operator Environment` | 既存の `Operator Environment` |
| `### Go-Live` | 既存の `Go-live` と `Production Go-Live`。production CharacterDefinition、readiness、mention capability の条件を1か所に統合 |
| `### Deploy` | 既存の `Daily Operations`。drain、active count、backup、migration、再起動、readiness、resume の順序を維持 |
| `## Recovery` | effect、drain、lease の復旧手順 |
| `### Effect Recovery` | `Daily Operations` 後半の unknown effect 操作と既存の `Effect Recovery`。Discord で結果を確認する条件を1か所に統合 |
| `### Shutdown And Drain` | 既存の `Shutdown And Drain`。停止前に running job と planned/executing effect が0になる条件を保持 |
| `### Lease Recovery` | 既存の `Lease Recovery`。scope assertion と復旧 loop を保持 |
| `## Configuration Reference` | Discord、model、database、health、credential の設定契約 |
| `### Discord` | 既存の `Discord Setup` |
| `### Model` | 既存の `Model Setup` |
| `### Database` | 既存の `Database Changes` |
| `### Health` | 既存の `Health` |
| `### Credential Boundary` | 既存の `Credential Boundary` |
| `## Tests And Layout` | 既存の `Tests And Layout` |

既存の fenced code block は内容を変更せず、対応する節へ移す。`Unknown effects are not retried automatically` から始まる説明と `Effect Recovery` の重複は、次の内容へ統合する。

```markdown
外部呼び出し後に状態が不明な effect は自動 retry しません。`unknown` の effect を一覧し、各 ID を `pnpm admin -- effect inspect effect-id` で確認します。Discord に message が存在すると確認できた場合だけ `succeeded` と external resource ID を付け、存在しないと確認できた場合だけ external resource ID なしの `failed` に reconcile します。結果が不明なら `unknown` のままにします。
```

`Production Go-Live` の独立した節は削除し、その条件を `Go-Live` の冒頭へ置く。`Daily Operations` は実態に合わせて `Deploy` に改名する。

- [ ] **Step 4: トップレベル見出しの構造を検証する**

Run:

```bash
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const headings = readFileSync("README.md", "utf8")
  .split("\n")
  .filter((line) => line.startsWith("## "));

assert.deepEqual(headings, [
  "## Development",
  "## Architecture",
  "## Initial Setup",
  "## Operations",
  "## Recovery",
  "## Configuration Reference",
  "## Tests And Layout",
]);
NODE
```

Expected: PASS with no output。

- [ ] **Step 5: 運用コマンドのコードブロックが変わっていないことを検証する**

Run:

```bash
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const before = execFileSync("git", ["show", "HEAD:README.md"], { encoding: "utf8" });
const after = readFileSync("README.md", "utf8");
const blocks = (text) => (text.match(/```[^\n]*\n[\s\S]*?```/g) ?? []).toSorted();

assert.deepEqual(blocks(after), blocks(before));
NODE
```

Expected: PASS with no output。失敗した場合は、追加・削除・変更したコードブロックを元の内容へ戻す。

- [ ] **Step 6: 一時的な開発フェーズ表現と旧見出しが残っていないことを検証する**

Run:

```bash
if rg -n 'Phase 1|^## (Prerequisites|Daily Operations|Production Go-Live|Effect Recovery|Shutdown And Drain|Lease Recovery|Discord Setup|Model Setup|Database Changes|Health|Credential Boundary)$' README.md; then
  exit 1
fi
```

Expected: PASS with no output。Recovery と Configuration Reference の子見出しは `###` なので検出されない。

- [ ] **Step 7: 差分とリポジトリ検証を実行する**

Run:

```bash
git diff --check
git diff -- README.md
nix develop -c pnpm format:check
```

Expected: `git diff --check` と `pnpm format:check` が exit 0。README の差分は、冒頭の書き換え、見出し変更、段落とコードブロックの移動、重複説明の統合だけを含む。

- [ ] **Step 8: README の再構成をコミットする**

```bash
git add README.md
git commit -m "docs: README をプロジェクト入口として再構成する"
```
