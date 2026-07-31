# process 固有 env file 読み込みの簡素化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway と cognition worker の foreground 起動を、`.env.*.local` を手で source せずに `pnpm start:gateway` / `pnpm start:worker` の 1 コマンドで完結させる。

**Architecture:** env file の読み込みを shell の定型句から `package.json` の start script へ移し、Node 24 標準の `--env-file` で行う。README の起動ブロック 4 箇所と、手動 source を前提にした記述 4 箇所を追随させる。実装コードと nix package は変更しない。

**Tech Stack:** Node 24 (`--env-file`)、pnpm 11.16、Markdown

**Spec:** `docs/superpowers/specs/2026-07-31-local-env-loading-design.md`

**Branch:** `simplify-local-env-loading`（作成済み。design doc は commit 済み）

---

## 自動テストを追加しない理由

この変更が触るのは `package.json` の script 文字列と README だけで、`src/` の実装には一切入らない。`package.json` の中身を読んで `--env-file` の有無を assert する test は、変更検知器にしかならず振る舞いを守らない。リポジトリにもその前例はない（`start:gateway` / `start:worker` を参照しているのは README のみ）。

代わりに Task 2 で実際に process を起動し、file 欠損時に停止すること、file がある時に preflight を通過することを確認する。これがこの変更の唯一の実質的な検証である。

---

### Task 1: start script を `--env-file` 方式へ変更

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 現在の script を確認する**

Run: `grep -n 'start:gateway\|start:worker\|"admin"' package.json`

Expected:

```
"start:gateway": "node dist/apps/discord-gateway.js",
"start:worker": "node dist/apps/cognition-worker.js",
"admin": "node dist/apps/admin-cli.js"
```

- [ ] **Step 2: 2 つの script を書き換える**

`package.json` の該当行を次に置き換える。`admin` は変更しない。

```json
    "start:gateway": "node --env-file=.env.gateway.local dist/apps/discord-gateway.js",
    "start:worker": "node --env-file=.env.worker.local dist/apps/cognition-worker.js",
```

- [ ] **Step 3: JSON が壊れていないことを確認する**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts)"`

Expected: `scripts` object が表示され、`start:gateway` と `start:worker` に `--env-file` が含まれる。parse error が出ないこと。

- [ ] **Step 4: format check を通す**

Run: `pnpm format:check`

Expected: 成功。失敗した場合は `pnpm format` を実行してから再度確認する。

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: load process-local env files from start scripts"
```

---

### Task 2: 起動時の振る舞いを検証する

**Files:**
- 変更なし（検証のみ）

このリポジトリの実 DB とローカル設定を使う。`.env` は direnv が読み込み済みである前提。読み込まれていない場合は `set -a; . ./.env; set +a` を子 shell で行う。

- [ ] **Step 1: build を最新にする**

Run: `pnpm build`

Expected: 成功。

- [ ] **Step 2: env file 欠損時に停止することを確認する**

```bash
mv .env.worker.local .env.worker.local.bak
pnpm start:worker; echo "exit=$?"
mv .env.worker.local.bak .env.worker.local
```

Expected: node が `.env.worker.local: not found` を出して起動せず、`exit=` に 0 以外が入る。worker の preflight ログは一切出ない。

**注意:** 最後の `mv` で必ず file を戻すこと。戻し忘れると以降の task が全て失敗する。

- [ ] **Step 3: 正常起動と readiness を確認する**

terminal A:

```bash
pnpm start:worker
```

terminal B:

```bash
curl --fail http://127.0.0.1:8081/ready && echo READY
```

Expected: terminal B が `{"healthy":true,"ready":true}` と `READY` を出す。

`cognition-worker.ts` の logger 呼び出しは iteration 失敗時と起動失敗時の `error` 2 箇所だけで、成功パスに info ログが無い。したがって terminal A には何も出ないのが正常である。preflight（migration、production CharacterDefinition、model routes）が通ったことの観測可能な証拠は `/ready` が `true` を返すことだけになる。

- [ ] **Step 4: credential boundary を確認する**

terminal A の worker を起動したまま、terminal B で次を実行する。

```bash
node --env-file=.env.worker.local -e 'console.log("DISCORD_TOKEN in worker env:", process.env.DISCORD_TOKEN === undefined ? "absent (ok)" : "PRESENT (bug)")'
node --env-file=.env.gateway.local -e 'console.log("OPENCODE_API_KEY in gateway env:", process.env.OPENCODE_API_KEY === undefined ? "absent (ok)" : "PRESENT (bug)")'
```

Expected: 両方とも `absent (ok)`。`PRESENT (bug)` が出た場合は、その値が direnv 経由で `.env` から来ていないか確認する。`.env` に process 固有 secret が残っていれば boundary の欠陥であり、報告して止まる。

- [ ] **Step 5: Ctrl+C で graceful shutdown することを確認する**

terminal A で Ctrl+C を押す。

Expected: worker が SIGINT を受けて終了し、terminal 自体は生きたまま残る。ここでもログは出ない。終了したことは、プロセスが消えることと `/ready` が接続不能になることで確認する。

- [ ] **Step 6: 検証結果を記録する（commit なし）**

このタスクはコード変更を伴わないため commit しない。Step 2 から Step 5 のいずれかが Expected と異なった場合は、次の task へ進まず報告する。

---

### Task 3: README の起動ブロック 4 箇所を置き換える

**Files:**
- Modify: `README.md`（Go-Live 節と Deploy 節）

4 箇所とも中身が同一の 2 種類（gateway 用・worker 用）で、置き換え後も同一になる。順に 1 箇所ずつ処理する。

- [ ] **Step 1: Go-Live の gateway ブロックを置き換える**

`## Operations` → `### Go-Live` 内の最初のコードブロック。次を

````markdown
```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.gateway.local
set +a
exec pnpm start:gateway
SH
```
````

こう置き換える。

````markdown
```bash
pnpm start:gateway
```
````

- [ ] **Step 2: Go-Live の worker ブロックを置き換える**

同じ節の次のコードブロック。次を

````markdown
```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.worker.local
set +a
exec pnpm start:worker
SH
```
````

こう置き換える。

````markdown
```bash
pnpm start:worker
```
````

- [ ] **Step 3: Deploy の gateway ブロックを置き換える**

`### Deploy` 節、「上のblockが成功終了するまでdeployを続けません。」の段落の直後のコードブロック。Step 1 と同じ置き換えを行う。

- [ ] **Step 4: Deploy の worker ブロックを置き換える**

`### Deploy` 節の次のコードブロック。Step 2 と同じ置き換えを行う。

- [ ] **Step 5: 置き換え漏れがないことを確認する**

Run: `grep -n 'env.gateway.local\|env.worker.local' README.md`

Expected: 残るのは散文の記述だけで、`. ./.env.gateway.local` や `. ./.env.worker.local` の source 行は 1 つも出ない。

Run: `grep -c 'pnpm start:gateway' README.md`

Expected: `2`

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: simplify gateway and worker startup blocks"
```

---

### Task 4: 手動 source を前提にした散文を更新する

**Files:**
- Modify: `README.md`（Development 節、Go-Live 節、Credential Boundary 節）

Task 3 でコードブロックだけを直すと、散文が実際の手順と食い違ったまま残る。4 箇所を直す。

- [ ] **Step 1: Development 節の段落を置き換える**

`.env` の説明の直後にある段落。次を

> process 固有の secret や credential は `.env.gateway.local`、`.env.worker.local` などに分け、起動する process の terminal でだけ追加で読み込みます。例えば Gateway は Discord credential だけ、worker は model provider credential だけを読み込みます。このリポジトリは process manager や secret 配布方式を固定しませんが、foreground 起動時も外部 deployment adapter も同じ境界を維持してください。

こう置き換える。

> process 固有の secret や credential は `.env.gateway.local`、`.env.worker.local` などに分けます。読み込むのは対象 process の start script だけで、`pnpm start:gateway` は `.env.gateway.local` を、`pnpm start:worker` は `.env.worker.local` を Node の `--env-file` で読み込みます。例えば Gateway は Discord credential だけ、worker は model provider credential だけを読み込み、対話 shell や admin-cli terminal の環境には入りません。このリポジトリは process manager や secret 配布方式を固定しませんが、foreground 起動時も外部 deployment adapter も同じ境界を維持してください。

- [ ] **Step 2: Go-Live 節の 3 端末の説明を置き換える**

`### Go-Live` 内、「Gateway、worker、admin-cli の3端末を使います。」で始まる段落。次を

> 各 terminal では `.envrc` によって `.env` の共通環境変数が読み込まれている前提です。Gateway terminal では `.env.gateway.local`、worker terminal では `.env.worker.local` だけを追加で読み込みます。admin-cli terminal は process 固有 secret を追加で読み込みません。外部 deployment adapter を使う場合も、この process 境界を維持します。

こう置き換える。段落の前半（「Gateway、worker、admin-cli の3端末を使います。」から「terminal 3 を admin-cli 用にします。」まで）は変更しない。

> 各 terminal では `.envrc` によって `.env` の共通環境変数が読み込まれている前提です。process 固有 secret は start script が読み込みます。`pnpm start:gateway` が `.env.gateway.local` を、`pnpm start:worker` が `.env.worker.local` を読み込み、admin-cli は process 固有 secret を読み込みません。外部 deployment adapter を使う場合も、この process 境界を維持します。

- [ ] **Step 3: `bash <<'SH'` の説明段落を置き換える**

Step 2 の段落の直後。この段落は現在「以降の block は」と書いているが、起動ブロックはもう包まれていないため、対象を限定し直す。次を

> 以降の block は `bash <<'SH'` で子 shell に閉じ込めてあります。この形を崩さないでください。`set -euo pipefail` や `: "${VAR:?...}"` を対話 shell へ直接貼ると、guard の失敗や foreground process への Ctrl+C が errexit で対話 shell 自体を終了させ、terminal ごと消えます。子 shell に閉じ込めれば、中断も guard の失敗も子 shell だけで完結し、Gateway と worker は SIGINT を受けて graceful shutdown します。process 固有の secret が対話 shell の環境に残らない利点もあります。

こう置き換える。

> 以降の block のうち、psql や admin-cli を実行するものは `bash <<'SH'` で子 shell に閉じ込めてあります。この形を崩さないでください。`set -euo pipefail` や `: "${VAR:?...}"` を対話 shell へ直接貼ると、guard の失敗が errexit で対話 shell 自体を終了させ、terminal ごと消えます。子 shell に閉じ込めれば guard の失敗も子 shell だけで完結します。Gateway と worker の起動 block は guard を持たないため包みません。Ctrl+C は node へ直接届き、両 process は SIGINT を受けて graceful shutdown します。

- [ ] **Step 4: Credential Boundary 節の段落を置き換える**

`### Credential Boundary` の最初の段落。次を

> Nix packageはGateway、worker、adminの3 executableを提供しますが、environment isolationやsecret配布方式は固定しません。`.env` は共通値だけの常時ロード用、`.env.gateway.local` と `.env.worker.local` は process 固有値の追加ロード用です。外部deployment adapterは各processへ必要な値だけを渡し、共有credential setを作らないでください。

こう置き換える。

> Nix packageはGateway、worker、adminの3 executableを提供しますが、environment isolationやsecret配布方式は固定しません。`.env` は共通値だけの常時ロード用で、direnv が全 terminal に読み込みます。`.env.gateway.local` と `.env.worker.local` は process 固有値用で、`pnpm start:gateway` と `pnpm start:worker` が Node の `--env-file` で対象 process にだけ読み込みます。Nix executable は env file を読まないため、外部deployment adapterが各processへ必要な値だけを渡し、共有credential setを作らないでください。

- [ ] **Step 5: 記述の食い違いが残っていないことを確認する**

Run: `grep -n '追加で読み込\|追加ロード' README.md`

Expected: 出力なし。残っていれば手動 source 前提の表現なので直す。

Run: `grep -n 'env-file' README.md`

Expected: Step 1 と Step 4 で入れた 2 箇所が出る。Step 2 の文面は「start script が読み込みます」とだけ書き `--env-file` の語を含まないため、ここには現れない。読み込み機構の名前は Development 節と Credential Boundary 節が説明し、Go-Live 節は運用手順として誰が読み込むかだけを述べる。

Run: `grep -n 'start script' README.md`

Expected: Step 1 と Step 2 で入れた 2 箇所が出る。

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe env file loading by start scripts"
```

---

### Task 5: 全体検証と PR

**Files:**
- 変更なし

- [ ] **Step 1: validate を通す**

Run: `pnpm validate`

Expected: format:check、lint、check、test:unit、test:spec が全て成功。

**注意:** `test:spec` は実 PostgreSQL を使い、共有 DB のため他 file の残留行で flake しうる。失敗した場合は同じ command を再実行して再現するか確認し、再現するなら報告して止まる。

- [ ] **Step 2: README の手順どおりに worker を起動する**

README の Go-Live 節をそのまま読み、terminal 2 の手順を実行する。

Run: `pnpm start:worker`

Expected: 起動して `/ready` が成功する。README に書いてある通りの 1 コマンドで済むこと。確認後 Ctrl+C で停止する。

- [ ] **Step 3: gateway の起動確認を運用者に依頼する**

gateway は実 Discord へ接続するため、agent は起動しない。運用者に `pnpm start:gateway` の実行と `/ready` の確認を依頼し、結果を待つ。

- [ ] **Step 4: push して PR を作成する**

```bash
git push -u origin simplify-local-env-loading
gh pr create --title "process 固有 env file の読み込みを start script へ移す" --body "$(cat <<'EOF'
## 目的

Gateway と cognition worker の起動から `.env.*.local` を手で source する定型句を取り除き、`pnpm start:gateway` / `pnpm start:worker` の 1 コマンドで完結させる。

## 変更

- `package.json` の `start:gateway` / `start:worker` で Node 24 の `--env-file` を使う
- README の起動 block 4 箇所を 1 行に置き換え、手動 source を前提にした記述 4 箇所を追随させる

## 設計

`docs/superpowers/specs/2026-07-31-local-env-loading-design.md`

## 確認

- env file 欠損時に node が起動前に停止すること
- `pnpm start:worker` が preflight を通過し `/ready` が成功すること
- worker 環境に `DISCORD_TOKEN` が、gateway 環境に provider credential が入らないこと
- Ctrl+C で graceful shutdown すること
- `pnpm validate`

## 非対象

`nix/package.nix` の 3 executable、`.env` の 3 ファイル分割方針、admin-cli の起動方法、各 process の設定契約。
EOF
)"
```

Expected: PR が作成され URL が表示される。

---

## Self-Review

**Spec coverage:**

| spec の項目 | 対応 task |
|---|---|
| `package.json` の 2 script を `--env-file` に | Task 1 |
| `admin` script は変更しない | Task 1 Step 2 で明示 |
| `--env-file-if-exists` を使わない（欠損で停止） | Task 2 Step 2 で検証 |
| 起動 block 4 箇所を 1 行に | Task 3 |
| 起動 block から `bash <<'SH'` を外す | Task 3 |
| psql / admin-cli の block は現状維持 | Task 3 で対象外、Task 4 Step 3 で説明を限定 |
| Operations 冒頭の記述更新 | Task 4 Step 2 |
| Development 節の記述更新 | Task 4 Step 1 |
| Credential Boundary 節の記述更新 | Task 4 Step 4 |
| 副次効果（secret が対話 shell に入らない） | Task 2 Step 4 で検証 |
| 非対象: nix package | どの task も `nix/` を触らない |
| 確認: worker の preflight と `/ready` | Task 2 Step 3、Task 5 Step 2 |
| 確認: env file 退避時に停止 | Task 2 Step 2 |
| 確認: credential boundary | Task 2 Step 4 |
| 確認: `pnpm validate` | Task 5 Step 1 |
| 確認: gateway は運用者が確認 | Task 5 Step 3 |

spec の `bash <<'SH'` 説明段落の扱いは spec 本文では「起動ブロックから包みを外す」までしか書いていないが、包みの説明段落自体が「以降の block は」と全体を指しているため放置すると矛盾する。Task 4 Step 3 で対象を限定する変更を追加した。

**Placeholder scan:** 各 step に実際の置き換え文字列と実行 command を記載済み。「Task N と同じ」と書いた Task 3 Step 3 / Step 4 は、直前の Step 1 / Step 2 に完全な置き換え内容があり、同一ファイル内の隣接 step を指すため参照で足りる。

**Type consistency:** コード変更は `package.json` の script 文字列 2 本のみ。Task 2 以降で参照する command 名（`pnpm start:gateway` / `pnpm start:worker`）は Task 1 で定義したものと一致する。health port は `.env` の `VICISSITUDE_WORKER_HEALTH_PORT=8081` と一致する。
