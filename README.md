# Vicissitude

Vicissitude は、Discord コミュニティ内で継続的に動作する AI キャラクター基盤です。

現在の実装は、Discord の明示的な mention を PostgreSQL を唯一の真実として受信し、応答を判断して Discord へ返す durable spine を提供します。受信、判断、外部作用を別の状態として永続化し、lease、deduplication、audit、redaction によって障害時も処理を追跡できる構成です。

## Development

Node.js 24、pnpm 11.16、Nix、PostgreSQL 17 が必要です。開発 shell に入り、依存関係の取得、build、test を実行します。

```bash
nix develop
```

上のコマンドで開発 shell に入り、以降のコマンドはその shell で実行します。

```bash
pnpm install
pnpm build
pnpm test
```

`.env.example` は自動ロードされません。各 executable に必要な環境変数だけを、foreground 起動時または外部 deployment adapter から明示的に渡してください。このリポジトリは process manager や secret 配布方式を固定しません。

## Architecture

PostgreSQL が event、job、decision、effect、character definition、channel capability、audit entry の正本です。実行単位は次の3つです。

- `discord-gateway`: Discord event の受信と永続化、管理 command の受付、永続化済み Discord effect の実行を担当します。Discord token を持つ唯一の process です。
- `cognition-worker`: job を claim し、production CharacterDefinition と model route を使って mention への応答を判断し、effect を永続化します。
- `admin-cli`: migration、CharacterDefinition、channel capability、drain、effect recovery を操作します。

Gateway と cognition worker は別 process として動かします。provider credential は cognition worker だけに、Discord token は Gateway だけに渡します。

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

`BACKUP_CONFIRMED_AT` は `pg_restore --list` が成功した backup file の mtime を指定します。snapshot を使う場合は、provider が記録した snapshot 完了時刻を operator が `export BACKUP_CONFIRMED_AT=...` で設定してください。現在時刻をそのまま指定しないでください。`nix build .#checks.x86_64-linux.staging-db-rehearsal`はtest-only databaseで同じattestationと3 cluster restoreを検証しますが、本番backup artifact自体の復元確認は別途必要です。

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

### Operator Environment

各operator terminalの開始時に、対象executableと同じ値をこのblockで設定します。`GUILD_ID`と`CHANNEL_ID`は実行processから継承されないため、対象を明示してください。health portはGatewayとworkerの起動設定と一致させます。

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

### Go-Live

本番用の CharacterDefinition はリポジトリに同梱しません。運用者が独立レビューした定義を import、activate してから Gateway と worker を起動します。

Gateway、worker、operator の3端末を使います。Gateway と cognition worker は別 process として起動します。手動なら terminal 1 で Gateway、terminal 2 で worker を foreground 起動し、terminal 3 を operator 用にします。外部 deployment adapter を使う場合も、この process 境界を維持します。

```bash
set -euo pipefail
# Operator Environment をこの terminal で設定済みであることを確認する。
: "${DATABASE_URL:?run Operator Environment first}"
: "${GUILD_ID:?run Operator Environment first}"
: "${CHANNEL_ID:?run Operator Environment first}"
: "${VICISSITUDE_GATEWAY_HEALTH_PORT:?run Operator Environment first}"
: "${VICISSITUDE_WORKER_HEALTH_PORT:?run Operator Environment first}"
# terminal 3: Gateway と worker は terminal 1、2 または外部deployment adapterで起動済みとする。
curl --fail http://127.0.0.1:${VICISSITUDE_GATEWAY_HEALTH_PORT}/ready
curl --fail http://127.0.0.1:${VICISSITUDE_WORKER_HEALTH_PORT}/ready
pnpm admin -- channel set "$GUILD_ID" "$CHANNEL_ID" --observe true --mentions true --actor admin-id --reason "enable reviewed target channel"
```

両方の readiness check が成功しなければ channel capability を有効にしません。

### Deploy

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
# Stop Gateway and cognition worker with the external deployment adapter used by this deployment.
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

上のblockが成功終了するまでdeployを続けません。migration後、外部deployment adapterまたは別terminalでGatewayとcognition workerの両方を起動します。手動運用ではGo-liveと同じく、次の二つを別terminalで実行します。

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

## Recovery

### Effect Recovery

外部呼び出し後に状態が不明な effect は自動 retry しません。`unknown` の effect を一覧し、各 ID を `pnpm admin -- effect inspect effect-id` で確認します。Discord に message が存在すると確認できた場合だけ `succeeded` と external resource ID を付け、存在しないと確認できた場合だけ external resource ID なしの `failed` に reconcile します。結果が不明なら `unknown` のままにします。

```bash
set -euo pipefail
: "${DATABASE_URL:?run Operator Environment first}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT id, run_id, guild_id, capability_channel_id, target_channel_id, target_message_id, updated_at FROM effects WHERE state = 'unknown' ORDER BY updated_at;"
```

```bash
set -euo pipefail
: "${DATABASE_URL:?run Operator Environment first}"
pnpm admin -- effect inspect effect-id
pnpm admin -- effect reconcile effect-id --state succeeded --external-resource-id discord-message-id --actor admin-id --reason "verified in Discord"
```

### Shutdown And Drain

`system drain` は新しい job claim だけを止め、effect claim は止めません。実行中 lease を待つ機能もありません。停止前に PostgreSQL の running job と planned または executing effect が 0 になるまで待ち、この手順で effect pipeline を drain します。0 にならない場合は強制停止せず、原因を調べます。期限切れ lease は fencing の対象です。外部 effect の実行結果が不明な場合は、Discord 側を確認してから reconcile します。

### Lease Recovery

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

## Configuration Reference

### Discord

Guilds、Guild Messages、Message Content intents を有効にします。`VICISSITUDE_GUILD_ID` は対象を単一 guild に限定し、`VICISSITUDE_ADMIN_USER_IDS` は管理者 allowlist をカンマ区切りで指定します。DM は対象外です。Gateway は singleton として動かします。

### Model

`config/model-routes.example.json` を `VICISSITUDE_MODEL_ROUTES_PATH` が指す場所へコピーします。provider credentials は `@earendil-works/pi-ai` の環境変数を使い、`cognition-worker` にだけ渡します。`discord-gateway` には渡しません。

### Database

起動時にmigrationは実行しません。直近24時間以内に作成し、`pg_restore --list`で確認したbackupまたはsnapshotの完了時刻を`BACKUP_CONFIRMED_AT`に渡します。`audit_entries`と適用済みmigration versionを確認します。offline rehearsalは`nix build .#checks.x86_64-linux.staging-db-rehearsal`で検証済みですが、本番backup artifactのrestoreは本番前に別途確認してください。

### Health

長時間プロセスは localhost の設定ポートで `GET /live` と `GET /ready` を公開します。`/live` はプロセス生存を返します。Gateway の `/ready` は DB migration preflight、system singleton と recovery、Discord login、command registration の完了を確認します。Gateway は production CharacterDefinition を確認しません。Worker の `/ready` は migration、production CharacterDefinition、model routes の起動 preflight が完了した時点で true になります。iteration が失敗すると false に戻り、次に成功した iteration で true に戻ります。`draining` と `stopped` は readiness を直接変えず、job claim を止めます。`/health` は使用しません。

### Credential Boundary

Nix packageはGateway、worker、adminの3 executableを提供しますが、environment isolationやsecret配布方式は固定しません。外部deployment adapterは各processへ必要な値だけを渡し、共有credential setを作らないでください。

Gatewayの設定契約は`DATABASE_URL`、`DISCORD_TOKEN`、`VICISSITUDE_GUILD_ID`、`VICISSITUDE_ADMIN_USER_IDS`、`VICISSITUDE_GATEWAY_HEALTH_PORT`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Gatewayにprovider credentialやmigrator credentialを渡しません。Workerの設定契約は`DATABASE_URL`、選択したprovider credential、`VICISSITUDE_WORKER_ID`、`VICISSITUDE_WORKER_HEALTH_PORT`、`VICISSITUDE_CHARACTER_ID`、`VICISSITUDE_MODEL_ROUTES_PATH`、`VICISSITUDE_MIGRATIONS_DIR`、`LOG_LEVEL`です。Workerに`DISCORD_TOKEN`やmigrator credentialを渡しません。message content、prompt、response、token、connection string、providerのraw errorはログに出しません。

offline staging checkはdatabase role/ACLを検証しますが、実運用のcredential注入、environment isolation、process isolationは検証しません。

## Tests And Layout

CIはformat、lint、型検査、unit、実PostgreSQLの`spec`、buildに加え、Nix packageと`staging-db-rehearsal`を実行します。外部credentialとprovider networkは不要です。主要ディレクトリは`src/apps`、`src/modules`、`src/adapters`、`migrations`、`spec`、`config`、`nix`です。
