# Vicissitude

Vicissitude は、Discord コミュニティ内で継続的に動作する AI キャラクター基盤です。

現在の実装は、Discord の明示的な mention を PostgreSQL を唯一の真実として受信し、応答を判断して Discord へ返す durable spine を提供します。受信、判断、外部作用を別の状態として永続化し、lease、deduplication、audit、redaction によって障害時も処理を追跡できる構成です。

## Development

Node.js 24、pnpm 11.16、Nix、PostgreSQL 17、direnv が必要です。開発 shell に入り、依存関係の取得、build、test を実行します。

```bash
nix develop
```

上のコマンドで開発 shell に入れます。direnv を使う場合は、`.envrc` が `use flake` と `dotenv` を実行するため、repository directory へ入った時点で Nix shell と `.env` の共通環境変数が読み込まれます。

```bash
pnpm install
pnpm build
pnpm test
```

`.env` は常に読み込まれる共通設定として扱います。`DATABASE_URL`、`VICISSITUDE_GUILD_ID`、`VICISSITUDE_MIGRATIONS_DIR`、health port、`VICISSITUDE_CHARACTER_ID`、`VICISSITUDE_MODEL_ROUTES_PATH`、`LOG_LEVEL` のように複数 process で共有する値だけを置きます。

process 固有の secret や credential は `.env.gateway.local`、`.env.worker.local` などに分け、起動する process の terminal でだけ追加で読み込みます。例えば Gateway は Discord credential だけ、worker は model provider credential だけを読み込みます。このリポジトリは process manager や secret 配布方式を固定しませんが、foreground 起動時も外部 deployment adapter も同じ境界を維持してください。

## Architecture

PostgreSQL が event、job、decision、effect、character definition、channel capability、audit entry の正本です。実行単位は次の3つです。

- `discord-gateway`: Discord event の受信と永続化、管理 command の受付、永続化済み Discord effect の実行を担当します。Discord token を持つ唯一の process です。
- `cognition-worker`: job を claim し、production CharacterDefinition と model route を使って mention への応答を判断し、effect を永続化します。
- `admin-cli`: migration、CharacterDefinition、channel capability、drain、effect recovery を操作します。

Gateway と cognition worker は別 process として動かします。provider credential は cognition worker だけに、Discord token は Gateway だけに渡します。

## Initial Setup

まず共通環境変数を `.env` に置き、direnv で常時読み込ませます。`.env.example` は全体の変数一覧です。実運用ではこの内容をそのまま一つの secret set にせず、共通値だけを `.env` に残し、process 固有値を `.env.gateway.local` や `.env.worker.local` へ移します。

```bash
test -f .env || cp .env.example .env
touch .env.gateway.local .env.worker.local
direnv allow
```

`.env.gateway.local` には Gateway だけが必要な値を置きます。

```dotenv
DISCORD_TOKEN=...
VICISSITUDE_ADMIN_USER_IDS=admin-discord-user-id
```

`.env.worker.local` には選択した model provider の credential だけを置きます。必要な変数名は `@earendil-works/pi-ai` と `config/model-routes.json` の provider 設定に合わせます。Discord token は worker に渡しません。

```dotenv
# 例: 選択した provider に必要な credential
# PROVIDER_API_KEY=...
```

### Database And Migration

PostgreSQL server は OS の daemon または managed service として起動済みである前提です。`DATABASE_URL` が指す PostgreSQL database を用意してから migration を適用します。app database が未作成の場合は、`postgres` などの既存 maintenance database に接続して app database を作成します。

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
DATABASE_NAME="$(node -e 'const url = new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(url.pathname.slice(1)));')"
psql postgresql://admin-user@host:5432/postgres -v ON_ERROR_STOP=1 -v db="$DATABASE_NAME" <<'SQL'
SELECT format('CREATE DATABASE %I', :'db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db')
\gexec
SQL
SH
```

空の database であっても、migration apply は backup または snapshot の確認時刻を要求します。既存 database に適用する場合は、必ず実データの backup を作成して restore 可能性を確認してください。新規作成直後の空 database では、その空 database の dump を作成して `pg_restore --list` で確認し、その dump の mtime を `BACKUP_CONFIRMED_AT` に使います。

```bash
bash <<'SH'
set -euo pipefail
pnpm install
pnpm build
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
: "${VICISSITUDE_MIGRATIONS_DIR:?set VICISSITUDE_MIGRATIONS_DIR in .env}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT 1;'
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
BACKUP_PATH=$BACKUP_DIR/vicissitude-$(date +%Y%m%d-%H%M%S).dump
pg_dump --format=custom --file "$BACKUP_PATH" "$DATABASE_URL"
pg_restore --list "$BACKUP_PATH" >/dev/null
BACKUP_CONFIRMED_AT="$(date --iso-8601=seconds --reference="$BACKUP_PATH")"
pnpm admin migration status
pnpm admin migration apply --backup-confirmed-at "$BACKUP_CONFIRMED_AT" --actor admin-id
pnpm admin character import ./character-reviewed.json --actor admin-id
pnpm admin character activate primary 1 --actor admin-id
SH
```

`BACKUP_CONFIRMED_AT` は `pg_restore --list` が成功した backup file の mtime を指定します。snapshot を使う場合は、provider が記録した snapshot 完了時刻を admin-cli 実行時に `BACKUP_CONFIRMED_AT=...` で設定してください。現在時刻をそのまま指定しないでください。`nix build .#checks.x86_64-linux.staging-db-rehearsal`はtest-only databaseで同じattestationと3 cluster restoreを検証しますが、本番backup artifact自体の復元確認は別途必要です。

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

## Operations

### Go-Live

本番用の CharacterDefinition はリポジトリに同梱しません。運用者が独立レビューした定義を import、activate してから Gateway と worker を起動します。

Gateway、worker、admin-cli の3端末を使います。Gateway と cognition worker は別 process として起動します。手動なら terminal 1 で Gateway、terminal 2 で worker を foreground 起動し、terminal 3 を admin-cli 用にします。各 terminal では `.envrc` によって `.env` の共通環境変数が読み込まれている前提です。Gateway terminal では `.env.gateway.local`、worker terminal では `.env.worker.local` だけを追加で読み込みます。admin-cli terminal は process 固有 secret を追加で読み込みません。外部 deployment adapter を使う場合も、この process 境界を維持します。

以降の block は `bash <<'SH'` で子 shell に閉じ込めてあります。この形を崩さないでください。`set -euo pipefail` や `: "${VAR:?...}"` を対話 shell へ直接貼ると、guard の失敗や foreground process への Ctrl+C が errexit で対話 shell 自体を終了させ、terminal ごと消えます。子 shell に閉じ込めれば、中断も guard の失敗も子 shell だけで完結し、Gateway と worker は SIGINT を受けて graceful shutdown します。process 固有の secret が対話 shell の環境に残らない利点もあります。

```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.gateway.local
set +a
exec pnpm start:gateway
SH
```

terminal 1 で Gateway を foreground 起動します。

```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.worker.local
set +a
exec pnpm start:worker
SH
```

terminal 2 で cognition worker を foreground 起動します。admin-cli は terminal 3 で次を実行します。

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
: "${VICISSITUDE_GUILD_ID:?set VICISSITUDE_GUILD_ID in .env}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?set gateway health port in .env}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?set worker health port in .env}"
# terminal 3: Gateway と worker は terminal 1、2 または外部deployment adapterで起動済みとする。
curl --fail http://127.0.0.1:${VICISSITUDE_GATEWAY_HEALTH_PORT}/ready
curl --fail http://127.0.0.1:${VICISSITUDE_WORKER_HEALTH_PORT}/ready
pnpm admin channel set "$VICISSITUDE_GUILD_ID" <discord-channel-id> --observe true --mentions true --actor admin-id --reason "enable reviewed target channel"
SH
```

両方の readiness check が成功しなければ channel capability を有効にしません。

### Deploy

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?set gateway health port in .env}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?set worker health port in .env}"
pnpm admin system drain --actor admin-id --reason "deploy"
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
# Stop Gateway and cognition worker with the external deployment adapter used by this deployment.
# Do not stop either process while the count is non-zero.
# If the count does not clear because a worker crashed or a lease expired, do not stop processes or migrate.
# Investigate first. Unknown effects are handled separately below.
pnpm build
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
BACKUP_PATH=$BACKUP_DIR/vicissitude-$(date +%Y%m%d-%H%M%S).dump
pg_dump --format=custom --file "$BACKUP_PATH" "$DATABASE_URL"
pg_restore --list "$BACKUP_PATH" >/dev/null
BACKUP_CONFIRMED_AT="$(date --iso-8601=seconds --reference="$BACKUP_PATH")"
pnpm admin migration status
pnpm admin migration apply --backup-confirmed-at "$BACKUP_CONFIRMED_AT" --actor admin-id
SH
```

上のblockが成功終了するまでdeployを続けません。migration後、外部deployment adapterまたは別terminalでGatewayとcognition workerの両方を起動します。手動運用ではGo-liveと同じく、次の二つを別terminalで実行します。

```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.gateway.local
set +a
exec pnpm start:gateway
SH
```

terminal 1 で Gateway を foreground 起動します。

```bash
bash <<'SH'
set -euo pipefail
set -a
. ./.env.worker.local
set +a
exec pnpm start:worker
SH
```

terminal 2 で cognition worker を foreground 起動します。admin-cli は terminal 3 で次を実行します。

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?set gateway health port in .env}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?set worker health port in .env}"
curl --fail http://127.0.0.1:${VICISSITUDE_GATEWAY_HEALTH_PORT}/ready
curl --fail http://127.0.0.1:${VICISSITUDE_WORKER_HEALTH_PORT}/ready
pnpm admin system resume --actor admin-id --reason "deploy complete"
SH
```

両方の readiness check が成功しなければ resume や mentions enable を実行しません。

`system drain` は新しい job claim だけを止め、effect claim は止めず、すぐに戻ります。in-flight または完了済み job が作った planned effect は drain 中も claim、実行されます。上の count が 0 になるまで Gateway と cognition worker を停止しないでください。この手順で effect pipeline も drain します。0 にならない場合は強制停止せず、running job、planned または executing effect、stale lease を調べます。期限切れ lease は fencing の対象ですが、外部 effect が実行済みか不明になると recovery の確認が必要です。

## Recovery

### Effect Recovery

外部呼び出し後に状態が不明な effect は自動 retry しません。`unknown` の effect を一覧し、各 ID を `pnpm admin effect inspect effect-id` で確認します。Discord に message が存在すると確認できた場合だけ `succeeded` と external resource ID を付け、存在しないと確認できた場合だけ external resource ID なしの `failed` に reconcile します。結果が不明なら `unknown` のままにします。

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT id, run_id, guild_id, capability_channel_id, target_channel_id, target_message_id, updated_at FROM effects WHERE state = 'unknown' ORDER BY updated_at;"
SH
```

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
pnpm admin effect inspect effect-id
pnpm admin effect reconcile effect-id --state succeeded --external-resource-id discord-message-id --actor admin-id --reason "verified in Discord"
SH
```

### Shutdown And Drain

`system drain` は新しい job claim だけを止め、effect claim は止めません。実行中 lease を待つ機能もありません。停止前に PostgreSQL の running job と planned または executing effect が 0 になるまで待ち、この手順で effect pipeline を drain します。0 にならない場合は強制停止せず、原因を調べます。期限切れ lease は fencing の対象です。外部 effect の実行結果が不明な場合は、Discord 側を確認してから reconcile します。

### Lease Recovery

単一 guild、単一 channel の deploy で running job が消えない場合は、channel capability を変更せず、同じ worker を復旧します。planned または executing effect の処理中に capability を変えると `capability_revoked` になるためです。recovery 対象の guild id と channel id は下の `psql -v` 引数で固定し、別 channel を巻き込みません。別の admin が recovery 中に別 channel を enable しない、という排他運用が必要です。scope の安全性は変数ではなく、下の DB assertions で確認します。

```bash
bash <<'SH'
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in .env and let direnv load it}"
: "${VICISSITUDE_GUILD_ID:?set VICISSITUDE_GUILD_ID in .env}"
violations="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v guild_id="$VICISSITUDE_GUILD_ID" -v channel_id=discord-channel-id -Atc "SELECT (SELECT count(*) FROM channel_capabilities WHERE respond_to_mentions AND NOT (guild_id = :'guild_id' AND channel_id = :'channel_id')) + (SELECT count(*) FROM jobs j JOIN events e ON e.id = j.event_id WHERE j.state IN ('queued', 'running') AND NOT (e.guild_id = :'guild_id' AND e.channel_id = :'channel_id')) + (SELECT count(*) FROM effects WHERE state IN ('planned', 'executing') AND NOT (guild_id = :'guild_id' AND capability_channel_id = :'channel_id'));" )" || {
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
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v guild_id="$VICISSITUDE_GUILD_ID" -v channel_id=discord-channel-id -Atc "SELECT j.id, j.event_id, j.lease_owner, j.leased_until FROM jobs j JOIN events e ON e.id = j.event_id WHERE j.state = 'running' AND e.guild_id = :'guild_id' AND e.channel_id = :'channel_id' ORDER BY j.leased_until NULLS FIRST;"
# 同じbuildのcognition workerを外部deployment adapterまたは別terminalで再起動する。
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
pnpm admin system resume --actor admin-id --reason "allow worker reclaim"
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
pnpm admin system drain --actor admin-id --reason "prepare deploy after recovery"
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
SH
```

queued job は deploy 後に処理できるため、drain-to-zero の count には含めません。active count が消えない場合は強制停止や migration をせず、原因を調べます。capability は recovery 中も変更しません。unknown effect は active drain count に含めず、Discord の結果を確認して別途 reconcile します。recovery と deploy が終わり、再起動後の readiness が成功してから `system resume`、最後に mentions enable を実行します。

## Configuration Reference

### Discord

Guilds、Guild Messages、Message Content intents を有効にします。`VICISSITUDE_GUILD_ID` は対象を単一 guild に限定し、`VICISSITUDE_ADMIN_USER_IDS` は管理者 allowlist をカンマ区切りで指定します。DM は対象外です。Gateway は singleton として動かします。

### Model

`config/model-routes.example.json` を `VICISSITUDE_MODEL_ROUTES_PATH` が指す場所へコピーします。provider credentials は `@earendil-works/pi-ai` の環境変数を使い、`cognition-worker` にだけ渡します。`discord-gateway` には渡しません。

### Database

`DATABASE_URL` が指す database は migration 実行前に作成しておきます。起動時に migration は実行しません。直近24時間以内に作成し、`pg_restore --list` で確認した backup または snapshot の完了時刻を `BACKUP_CONFIRMED_AT` に渡します。新規作成直後の空 database でも、空 database の dump を作成して restore list を確認してから migration を適用します。`audit_entries` と適用済み migration version を確認します。offline rehearsal は `nix build .#checks.x86_64-linux.staging-db-rehearsal` で検証済みですが、本番 backup artifact の restore は本番前に別途確認してください。

### Health

長時間プロセスは localhost の設定ポートで `GET /live` と `GET /ready` を公開します。`/live` はプロセス生存を返します。Gateway の `/ready` は DB migration preflight、system singleton と recovery、Discord login、command registration の完了を確認します。Gateway は production CharacterDefinition を確認しません。Worker の `/ready` は migration、production CharacterDefinition、model routes の起動 preflight が完了した時点で true になります。iteration が失敗すると false に戻り、次に成功した iteration で true に戻ります。`draining` と `stopped` は readiness を直接変えず、job claim を止めます。`/health` は使用しません。

### Credential Boundary

Nix packageはGateway、worker、adminの3 executableを提供しますが、environment isolationやsecret配布方式は固定しません。`.env` は共通値だけの常時ロード用、`.env.gateway.local` と `.env.worker.local` は process 固有値の追加ロード用です。外部deployment adapterは各processへ必要な値だけを渡し、共有credential setを作らないでください。

Gatewayの設定契約は`DATABASE_URL`、`DISCORD_TOKEN`、`VICISSITUDE_GUILD_ID`、`VICISSITUDE_ADMIN_USER_IDS`、`VICISSITUDE_GATEWAY_HEALTH_PORT`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Gatewayにprovider credentialやmigrator credentialを渡しません。Workerの設定契約は`DATABASE_URL`、選択したprovider credential、`VICISSITUDE_WORKER_ID`、`VICISSITUDE_WORKER_HEALTH_PORT`、`VICISSITUDE_CHARACTER_ID`、`VICISSITUDE_MODEL_ROUTES_PATH`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Workerに`DISCORD_TOKEN`やmigrator credentialを渡しません。本番でGateway、worker、adminのDB credentialも分ける場合は、共通 `.env` から `DATABASE_URL` を外し、各 process の local env または deployment adapter で対象 executable 用の `DATABASE_URL` を渡してください。message content、prompt、response、token、connection string、providerのraw errorはログに出しません。

offline staging checkはdatabase role/ACLを検証しますが、実運用のcredential注入、environment isolation、process isolationは検証しません。

## Tests And Layout

CIはformat、lint、型検査、unit、実PostgreSQLの`spec`、buildに加え、Nix packageと`staging-db-rehearsal`を実行します。外部credentialとprovider networkは不要です。主要ディレクトリは`src/apps`、`src/modules`、`src/adapters`、`migrations`、`spec`、`config`、`nix`です。
