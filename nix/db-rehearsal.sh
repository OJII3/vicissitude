#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${out:?out is required}"
: "${package:?package is required}"
: "${sql_dir:?sql_dir is required}"

started_at=$(date +%s)
root=$(mktemp -d)
log="$root/rehearsal.log"
port=55432
exec 4>&2
exec >"$log" 2>&1

cleanup() {
  for cluster in populated-restore migration-before-restore source; do
    if [ -d "$root/$cluster/data" ]; then
      pg_ctl -D "$root/$cluster/data" -m immediate -w stop >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$root"
}

fail() {
  trap - ERR
  printf 'check=staging-db-rehearsal role=%s operation=%s expected=%s\n' "$1" "$2" "$3" >&4
  exit 1
}

trap cleanup EXIT
trap 'fail internal integration success' ERR

socket_dir() { printf '%s/%s/socket' "$root" "$1"; }

psql_as() {
  local cluster=$1 role=$2 database=$3
  shift 3
  psql -X -h "$(socket_dir "$cluster")" -p "$port" -U "$role" -d "$database" -v ON_ERROR_STOP=1 "$@"
}

start_cluster() {
  local cluster=$1 data="$root/$1/data" socket
  socket=$(socket_dir "$cluster")
  mkdir -p "$socket"
  initdb -D "$data" --username=postgres --auth=trust --no-locale --encoding=UTF8 >/dev/null
  cat >>"$data/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$socket'
port = $port
EOF
  pg_ctl -D "$data" -l "$root/$cluster/postgresql.log" -w start >/dev/null
  psql_as "$cluster" postgres postgres -c \
    "CREATE ROLE vicissitude_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
     CREATE ROLE vicissitude_gateway LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
     CREATE ROLE vicissitude_worker LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;" >/dev/null
}

run_sql_file() {
  local cluster=$1 role=$2 file=$3
  psql_as "$cluster" "$role" vicissitude -f "$file" >/dev/null
}

expect_denied() {
  local cluster=$1 role=$2 operation=$3 statement=$4 error_file="$root/denied-$1-$2-$3.err"
  if psql_as "$cluster" "$role" vicissitude -v VERBOSITY=verbose -c "$statement" > /dev/null 2>"$error_file"; then
    fail "$role" "$operation" deny
  fi
  if ! grep -q '42501' "$error_file"; then
    fail "$role" "$operation" 'SQLSTATE-42501'
  fi
}

positive_probes() {
  local cluster=$1
  psql_as "$cluster" vicissitude_gateway vicissitude >/dev/null <<'SQL'
BEGIN;
SELECT version FROM schema_migrations;
SELECT mode FROM system_state;
SELECT guild_id FROM channel_capabilities;
INSERT INTO channel_capabilities (guild_id, channel_id, updated_at, updated_by, reason)
VALUES ('gateway-probe', 'gateway-probe', clock_timestamp(), 'gateway-probe', 'probe');
UPDATE channel_capabilities SET reason = 'updated' WHERE guild_id = 'gateway-probe' AND channel_id = 'gateway-probe';
SELECT id FROM events LIMIT 1;
INSERT INTO events (
  id, schema_version, source, external_event_id, external_version, kind, visibility,
  guild_id, channel_id, actor_id, actor_kind, occurred_at, received_at, content, expires_at
) VALUES (
  '10000000-0000-0000-0000-000000000001', 1, 'discord', 'gateway-positive-probe', '1',
  'message.created', 'observed', 'gateway-probe', 'gateway-probe', 'gateway-probe', 'human',
  clock_timestamp(), clock_timestamp(), '{}', clock_timestamp() + interval '1 day'
);
INSERT INTO jobs (id, kind, event_id, state, available_at, created_at, updated_at)
VALUES (
  '10000000-0000-0000-0000-000000000002', 'mention_response',
  '10000000-0000-0000-0000-000000000001', 'queued', clock_timestamp(), clock_timestamp(), clock_timestamp()
);
SELECT id FROM effects LIMIT 1;
UPDATE effects SET updated_at = updated_at WHERE id = '00000000-0000-0000-0000-000000000005';
INSERT INTO audit_entries (id, category, summary, created_at)
VALUES ('10000000-0000-0000-0000-000000000003', 'gateway.probe', '{}', clock_timestamp());
SELECT gen_random_uuid();
ROLLBACK;
SQL

  psql_as "$cluster" vicissitude_worker vicissitude >/dev/null <<'SQL'
BEGIN;
SELECT version FROM schema_migrations;
SELECT mode FROM system_state;
SELECT id FROM events LIMIT 1;
SELECT id FROM jobs LIMIT 1;
SELECT character_id FROM character_definitions LIMIT 1;
SELECT id FROM decision_runs LIMIT 1;
SELECT id FROM effects LIMIT 1;
UPDATE jobs SET updated_at = updated_at WHERE id = '00000000-0000-0000-0000-000000000002';
UPDATE decision_runs SET reason_codes = reason_codes WHERE id = '00000000-0000-0000-0000-000000000003';
INSERT INTO decision_runs (
  id, job_id, event_id, character_id, character_version, state, action_kind, reason_codes,
  model_route_version, started_at
) VALUES (
  '20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000009',
  '00000000-0000-0000-0000-000000000008', 'staging-validation', 1, 'running', 'reply',
  ARRAY['worker-probe'], 'worker-probe-route', clock_timestamp()
);
INSERT INTO model_calls (id, run_id, purpose, provider, model, route_version, attempt, state, latency_ms, created_at)
VALUES (
  '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
  'worker-probe', 'fixture', 'fixture-model', 'worker-probe-route', 1, 'succeeded', 1, clock_timestamp()
);
INSERT INTO effects (
  id, run_id, effect_slot, kind, state, guild_id, capability_channel_id, target_channel_id,
  target_message_id, payload, capability_decision, created_at, updated_at
) VALUES (
  '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
  'worker-probe', 'discord.reply', 'planned', 'guild-staging', 'channel-staging', 'channel-staging',
  'worker-probe-message', '{}', '{}', clock_timestamp(), clock_timestamp()
);
INSERT INTO audit_entries (id, category, event_id, job_id, run_id, effect_id, summary, created_at)
VALUES (
  '20000000-0000-0000-0000-000000000004', 'worker.probe',
  '00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000009',
  '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003',
  '{}', clock_timestamp()
);
SELECT gen_random_uuid();
ROLLBACK;
SQL
}

negative_probes() {
  local cluster=$1
  expect_denied "$cluster" vicissitude_gateway character-read 'SELECT character_id FROM character_definitions'
  expect_denied "$cluster" vicissitude_gateway character-write "UPDATE character_definitions SET status = 'retired'"
  expect_denied "$cluster" vicissitude_gateway decision-write 'UPDATE decision_runs SET reason_codes = reason_codes'
  expect_denied "$cluster" vicissitude_gateway model-write 'UPDATE model_calls SET latency_ms = latency_ms'
  expect_denied "$cluster" vicissitude_gateway system-write "UPDATE system_state SET reason = 'denied'"
  expect_denied "$cluster" vicissitude_gateway migration-write "UPDATE schema_migrations SET checksum = 'denied'"
  expect_denied "$cluster" vicissitude_gateway ddl 'CREATE TABLE gateway_denied(id integer)'
  expect_denied "$cluster" vicissitude_gateway role-change 'CREATE ROLE gateway_denied_role'

  expect_denied "$cluster" vicissitude_worker channel-read 'SELECT guild_id FROM channel_capabilities'
  expect_denied "$cluster" vicissitude_worker channel-write "UPDATE channel_capabilities SET reason = 'denied'"
  expect_denied "$cluster" vicissitude_worker system-write "UPDATE system_state SET reason = 'denied'"
  expect_denied "$cluster" vicissitude_worker event-write "UPDATE events SET content = '{}'"
  expect_denied "$cluster" vicissitude_worker effect-update 'UPDATE effects SET updated_at = updated_at'
  expect_denied "$cluster" vicissitude_worker migration-write "UPDATE schema_migrations SET checksum = 'denied'"
  expect_denied "$cluster" vicissitude_worker ddl 'CREATE TABLE worker_denied(id integer)'
  expect_denied "$cluster" vicissitude_worker role-change 'CREATE ROLE worker_denied_role'
}

privilege_snapshot() {
  local cluster=$1
  psql_as "$cluster" postgres vicissitude -At <<'SQL'
SELECT value FROM (
  SELECT 'database-owner|' || pg_get_userbyid(datdba) AS value
    FROM pg_database WHERE datname = current_database()
  UNION ALL
  SELECT 'schema-owner|' || pg_get_userbyid(nspowner)
    FROM pg_namespace WHERE nspname = 'public'
  UNION ALL
  SELECT 'table-owner|' || relation.relname || '|' || pg_get_userbyid(relation.relowner)
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
  UNION ALL
  SELECT 'role|' || rolname || '|' || rolcanlogin || '|' || rolinherit || '|' || rolsuper || '|' || rolcreatedb || '|' || rolcreaterole || '|' || rolreplication
    FROM pg_roles WHERE rolname IN ('vicissitude_migrator', 'vicissitude_gateway', 'vicissitude_worker')
  UNION ALL
  SELECT 'privilege|' || role_name || '|' || table_name || '|' || operation || '|' ||
    has_table_privilege(role_name, format('public.%I', table_name), operation)
    FROM unnest(ARRAY['vicissitude_gateway', 'vicissitude_worker']) role_name
    CROSS JOIN unnest(ARRAY['schema_migrations', 'system_state', 'channel_capabilities', 'events', 'jobs', 'character_definitions', 'decision_runs', 'model_calls', 'effects', 'audit_entries']) table_name
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) operation
  UNION ALL
  SELECT 'default-acl|' || pg_get_userbyid(default_acl.defaclrole) || '|' || default_acl.defaclobjtype::text || '|' ||
    COALESCE(pg_get_userbyid(acl.grantee), 'PUBLIC') || '|' || acl.privilege_type
    FROM pg_default_acl default_acl CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) acl
) snapshot ORDER BY value;
SQL
}

start_cluster source
start_cluster migration-before-restore
start_cluster populated-restore

psql_as source postgres postgres -c 'CREATE DATABASE vicissitude OWNER vicissitude_migrator' >/dev/null

migration_before="$root/migration-before.dump"
populated="$root/populated.dump"
pg_dump -h "$(socket_dir source)" -p "$port" -U vicissitude_migrator -d vicissitude \
  --create --format=custom --file="$migration_before"
pg_restore --list "$migration_before" >"$root/migration-before.list"
migration_before_hash=$(sha256sum "$migration_before" | cut -d' ' -f1)
migration_before_mtime=$(stat -c %Y "$migration_before")

pg_restore -h "$(socket_dir migration-before-restore)" -p "$port" -U postgres -d postgres \
  --create --exit-on-error "$migration_before" >/dev/null
test "$(psql_as migration-before-restore postgres vicissitude -Atc \
  "SELECT count(*) FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind = 'r'")" = 0
test "$(psql_as migration-before-restore postgres vicissitude -Atc "SELECT to_regclass('public.schema_migrations') IS NULL")" = t

backup_confirmed_at=$(date -u -d "@$migration_before_mtime" '+%Y-%m-%dT%H:%M:%S.000Z')
encoded_socket=$(printf '%s' "$(socket_dir source)" | sed 's#/#%2F#g')
database_url="postgresql://vicissitude_migrator@$encoded_socket/vicissitude?port=$port"
DATABASE_URL="$database_url" VICISSITUDE_MIGRATIONS_DIR="$package/lib/vicissitude/migrations" \
  "$package/bin/vicissitude-admin" migration apply --backup-confirmed-at "$backup_confirmed_at" \
  --actor staging-validation >/dev/null

run_sql_file source vicissitude_migrator "$sql_dir/runtime-acl.sql"
run_sql_file source vicissitude_migrator "$sql_dir/fixture.sql"
run_sql_file source postgres "$sql_dir/privilege-matrix.sql"
run_sql_file source postgres "$sql_dir/catalog-assertions.sql"
positive_probes source
negative_probes source

pg_dump -h "$(socket_dir source)" -p "$port" -U vicissitude_migrator -d vicissitude \
  --create --format=custom --file="$populated"
pg_restore --list "$populated" >"$root/populated.list"
populated_hash=$(sha256sum "$populated" | cut -d' ' -f1)
populated_mtime=$(stat -c %Y "$populated")

pg_restore -h "$(socket_dir populated-restore)" -p "$port" -U postgres -d postgres \
  --create --exit-on-error "$populated" >/dev/null
run_sql_file populated-restore postgres "$sql_dir/privilege-matrix.sql"
run_sql_file populated-restore postgres "$sql_dir/catalog-assertions.sql"
positive_probes populated-restore
negative_probes populated-restore

privilege_snapshot source >"$root/source-privilege-snapshot"
privilege_snapshot populated-restore >"$root/restored-privilege-snapshot"
cmp "$root/source-privilege-snapshot" "$root/restored-privilege-snapshot" >/dev/null || \
  fail internal privilege-snapshot equal

migration_checksum=$(sha256sum "$package/lib/vicissitude/migrations/0001_durable_spine.sql" | cut -d' ' -f1)
expected_migration="0001|durable_spine|$migration_checksum"
source_migration=$(psql_as source postgres vicissitude -At -F '|' -c \
  "SELECT version, name, checksum FROM schema_migrations WHERE version = '0001'")
restored_migration=$(psql_as populated-restore postgres vicissitude -At -F '|' -c \
  "SELECT version, name, checksum FROM schema_migrations WHERE version = '0001'")
test "$source_migration" = "$expected_migration"
test "$restored_migration" = "$expected_migration"

source_audit=$(psql_as source postgres vicissitude -Atc \
  "SELECT summary->>'backupConfirmedAt' FROM audit_entries WHERE category = 'migration.applied' ORDER BY created_at DESC LIMIT 1")
restored_audit=$(psql_as populated-restore postgres vicissitude -Atc \
  "SELECT summary->>'backupConfirmedAt' FROM audit_entries WHERE category = 'migration.applied' ORDER BY created_at DESC LIMIT 1")
test "$source_audit" = "$backup_confirmed_at"
test "$restored_audit" = "$backup_confirmed_at"
test "$(psql_as source postgres vicissitude -Atc \
  "SELECT summary->'appliedVersions' @> '[\"0001\"]'::jsonb FROM audit_entries WHERE category = 'migration.applied' ORDER BY created_at DESC LIMIT 1")" = t

test "$(sha256sum "$migration_before" | cut -d' ' -f1)" = "$migration_before_hash"
test "$(sha256sum "$populated" | cut -d' ' -f1)" = "$populated_hash"
verified_at=$(date +%s)
test "$migration_before_mtime" -ge "$started_at" && test "$migration_before_mtime" -le "$verified_at"
test "$populated_mtime" -ge "$started_at" && test "$populated_mtime" -le "$verified_at"

migration_before_contents=$(jq -Rs 'split("\n") | map(select(length > 0))' "$root/migration-before.list")
populated_contents=$(jq -Rs 'split("\n") | map(select(length > 0))' "$root/populated.list")
manifest="$root/manifest.json"
jq -n \
  --arg checksum "$migration_checksum" \
  --arg backup_confirmed_at "$backup_confirmed_at" \
  --arg migration_before_hash "$migration_before_hash" \
  --arg populated_hash "$populated_hash" \
  --argjson migration_before_mtime "$migration_before_mtime" \
  --argjson populated_mtime "$populated_mtime" \
  --argjson migration_before_contents "$migration_before_contents" \
  --argjson populated_contents "$populated_contents" \
  '{
    format: 1,
    migration: {version: "0001", name: "durable_spine", checksum: $checksum},
    migrationAudit: {event: "migration.applied", backupConfirmedAt: $backup_confirmed_at},
    artifacts: {
      migrationBefore: {path: "migration-before.dump", sha256: $migration_before_hash, mtime: $migration_before_mtime, contents: $migration_before_contents},
      populated: {path: "populated.dump", sha256: $populated_hash, mtime: $populated_mtime, contents: $populated_contents}
    },
    clusters: {source: "source", migrationBeforeRestore: "migration-before-restore", populatedRestore: "populated-restore"}
  }' >"$manifest"

jq -e \
  --arg checksum "$migration_checksum" \
  --arg backup_confirmed_at "$backup_confirmed_at" \
  --arg migration_before_hash "$(sha256sum "$migration_before" | cut -d' ' -f1)" \
  --arg populated_hash "$(sha256sum "$populated" | cut -d' ' -f1)" \
  --argjson started_at "$started_at" \
  --argjson verified_at "$verified_at" \
  --argjson migration_before_contents "$(pg_restore --list "$migration_before" | jq -Rs 'split("\n") | map(select(length > 0))')" \
  --argjson populated_contents "$(pg_restore --list "$populated" | jq -Rs 'split("\n") | map(select(length > 0))')" \
  '.format == 1
    and .migration == {version: "0001", name: "durable_spine", checksum: $checksum}
    and .migrationAudit == {event: "migration.applied", backupConfirmedAt: $backup_confirmed_at}
    and (.artifacts.migrationBefore.sha256 == $migration_before_hash)
    and (.artifacts.populated.sha256 == $populated_hash)
    and (.artifacts.migrationBefore.sha256 | test("^[0-9a-f]{64}$"))
    and (.artifacts.populated.sha256 | test("^[0-9a-f]{64}$"))
    and (.artifacts.migrationBefore.mtime | type == "number")
    and (.artifacts.populated.mtime | type == "number")
    and (.artifacts.migrationBefore.mtime >= $started_at and .artifacts.migrationBefore.mtime <= $verified_at)
    and (.artifacts.populated.mtime >= $started_at and .artifacts.populated.mtime <= $verified_at)
    and (.artifacts.migrationBefore.contents == $migration_before_contents)
    and (.artifacts.populated.contents == $populated_contents)
    and (.artifacts.migrationBefore.contents | length > 0)
    and (.artifacts.populated.contents | length > 0)
    and .clusters == {source: "source", migrationBeforeRestore: "migration-before-restore", populatedRestore: "populated-restore"}' \
  "$manifest" >/dev/null

mkdir -p "$out"
printf '%s\n' 'staging-db-rehearsal: PASS' >"$out/result"
