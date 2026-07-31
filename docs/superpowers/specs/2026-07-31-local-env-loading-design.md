# process 固有 env file 読み込みの簡素化設計

## 目的

Gateway と cognition worker の foreground 起動手順から、`.env.gateway.local` / `.env.worker.local` を手で source する定型句を取り除く。起動は `pnpm start:gateway` / `pnpm start:worker` の 1 コマンドで完結させる。

現在の README は起動のたびに次を要求している。

```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.gateway.local
set +a
exec pnpm start:gateway
SH
```

この形は Go-Live と Deploy に合計 4 箇所ある。

## 方針

読み込みを shell の手順から `package.json` の start script へ移す。Node 24 の `--env-file` を使う。

```json
"start:gateway": "node --env-file=.env.gateway.local dist/apps/discord-gateway.js",
"start:worker":  "node --env-file=.env.worker.local dist/apps/cognition-worker.js"
```

`admin` script は変更しない。admin-cli terminal が process 固有 secret を追加で読み込まない、という現在の契約をそのまま維持する。

## 根拠

- `engines` は既に `node >=24 <25` で、`--env-file` は標準機能である。依存を追加しない。
- Node の `--env-file` は、既に process 環境に存在する変数を env file の値で上書きしない。実測で確認済み。したがって direnv が読み込んだ `.env` の共通値が `.env.*.local` に侵食される事故は起きない。両者の変数集合は元々互いに交わらないが、優先順位としても安全側に倒れている。
- `--env-file` は指定ファイルが存在しないと node が起動前にエラーで停止する。`--env-file-if-exists` は使わない。README の Initial Setup が `touch .env.gateway.local .env.worker.local` を実行するためローカルでは常に存在し、欠損は設定漏れを意味する。黙って続行する経路を作らない。

## 副次的な効果

process 固有 secret が interactive shell の環境にも direnv の環境にも入らなくなる。Gateway 用の terminal で admin-cli を実行しても `DISCORD_TOKEN` が環境に見えない。credential boundary は現状より厳密になる。

## README の変更

起動ブロック 4 箇所を次に置き換える。

```bash
pnpm start:gateway
```

起動ブロックからは `bash <<'SH'` の包みも外す。README がこの形を要求していた理由は、`set -euo pipefail` や `: "${VAR:?}"` を対話 shell に貼ると guard の失敗や foreground process への Ctrl+C が対話 shell 自体を終了させることだった。起動ブロックには guard 文が無く、中身は `set -a` による source だけだったため、source が消えれば包む理由も消える。

psql や admin-cli を含む他のブロックは `: "${VAR:?}"` guard が実際に効いているため、現在の形のまま残す。

あわせて、手動 source を前提にした記述を更新する。

- Operations 冒頭の「Gateway terminal では `.env.gateway.local`、worker terminal では `.env.worker.local` だけを追加で読み込みます」を、読み込み主体が start script であるという説明に改める。
- Development 節と Configuration Reference の Credential Boundary 節にある、process 固有値の「追加ロード」に関する表現を同様に改める。

`.env` を direnv が全 terminal で読み込む点、`.env.example` が全変数の一覧である点、3 端末で運用する点は変更しない。

## 非対象

- `nix/package.nix` の 3 executable。`makeWrapper` が node に script を渡すだけで env file を読まない現在の作りを維持する。環境注入は外部 deployment adapter の責務であるという README の立場を変えない。
- `.env` / `.env.gateway.local` / `.env.worker.local` という 3 ファイル分割の方針。
- `.envrc` と direnv の設定。
- admin-cli の起動方法。
- 各 process の設定契約（読み取る環境変数の集合）。

## 確認

- `pnpm start:worker` を起動し、migration、production CharacterDefinition、model routes の preflight を通過して `/ready` が成功すること。
- `.env.worker.local` を一時的に退避した状態で `pnpm start:worker` が node のエラーで停止すること。
- worker の terminal に `DISCORD_TOKEN` が、gateway の terminal に provider credential が入らないこと。
- `pnpm validate` が成功すること。
- README の起動手順どおりに実行して Gateway が起動すること。実 Discord へ接続するため運用者が確認する。
