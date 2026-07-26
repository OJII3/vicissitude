#!/usr/bin/env bash
set -euo pipefail
umask 077
tmp=$(mktemp -d)
log=$tmp/log
cleanup() { for c in source migration-before-restore populated-restore; do [ -d "$tmp/$c" ] && pg_ctl -D "$tmp/$c" -m immediate stop >/dev/null 2>&1 || true; done; rm -rf "$tmp"; }
trap cleanup EXIT
fail() { printf '%s\n' "check=staging-db-rehearsal role=internal operation=integration expected=success" >&2; exit 1; }
trap fail ERR
start() { local name=$1; initdb -D "$tmp/$name" --auth=trust >/dev/null; mkdir "$tmp/$name/socket"; pg_ctl -D "$tmp/$name" -o "-k $tmp/$name/socket -p 55432 -c listen_addresses='' -c unix_socket_directories=$tmp/$name/socket" -w start >/dev/null; psql -X -h "$tmp/$name/socket" -p 55432 -d postgres -v ON_ERROR_STOP=1 -c "create role postgres superuser createdb createrole login; create role vicissitude_migrator login noinherit nosuperuser nocreatedb nocreaterole noreplication; create role vicissitude_gateway login noinherit nosuperuser nocreatedb nocreaterole noreplication; create role vicissitude_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication;" >/dev/null; }
sql() { psql -X -h "$1/socket" -p 55432 -d "${2:-vicissitude}" -v ON_ERROR_STOP=1 -f "$3" >/dev/null; }
start source; start migration-before-restore; start populated-restore
psql -X -h "$tmp/source/socket" -p 55432 -d postgres -v ON_ERROR_STOP=1 -c 'create database vicissitude owner vicissitude_migrator;' >/dev/null
pg_dump -h "$tmp/source/socket" -p 55432 -U vicissitude_migrator --create --format=custom --file="$tmp/migration-before.dump" vicissitude >/dev/null
pg_restore --list "$tmp/migration-before.dump" >/dev/null
pg_restore --create --exit-on-error -U postgres -h "$tmp/migration-before-restore/socket" -p 55432 -d postgres "$tmp/migration-before.dump" >/dev/null
test "$(psql -X -At -h "$tmp/migration-before-restore/socket" -p 55432 -d vicissitude -c "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r'")" = 0
mtime=$(stat -c %Y "$tmp/migration-before.dump")
iso=$(date -u -d "@$mtime" '+%Y-%m-%dT%H:%M:%SZ')
encoded=$(printf '%s' "$tmp/source/socket" | sed 's#/#%2F#g')
url="postgresql://vicissitude_migrator@$encoded/vicissitude?port=55432"
DATABASE_URL="$url" VICISSITUDE_MIGRATIONS_DIR="$package/lib/vicissitude/migrations" "$package/bin/vicissitude-admin" migration apply --backup-confirmed-at "$iso" --actor staging-validation >/dev/null
sql "$tmp/source" vicissitude "$sql_dir/runtime-acl.sql"
sql "$tmp/source" vicissitude "$sql_dir/fixture.sql"
sql "$tmp/source" vicissitude "$sql_dir/privilege-matrix.sql"
sql "$tmp/source" vicissitude "$sql_dir/catalog-assertions.sql"
psql -X -h "$tmp/source/socket" -p 55432 -d vicissitude -v ON_ERROR_STOP=1 -c "begin; set role vicissitude_gateway; select gen_random_uuid(); select id from events; rollback;" >/dev/null
psql -X -h "$tmp/source/socket" -p 55432 -d vicissitude -v ON_ERROR_STOP=1 -c "begin; set role vicissitude_worker; select character_id from character_definitions; rollback;" >/dev/null
pg_dump -h "$tmp/source/socket" -p 55432 -U vicissitude_migrator --create --format=custom --file="$tmp/populated.dump" vicissitude >/dev/null
pg_restore --list "$tmp/populated.dump" >/dev/null
pg_restore -U postgres -h "$tmp/populated-restore/socket" -p 55432 -d postgres --create --exit-on-error "$tmp/populated.dump" >/dev/null
sql "$tmp/populated-restore" vicissitude "$sql_dir/catalog-assertions.sql"
mkdir -p "$out"
printf '%s\n' 'staging-db-rehearsal: PASS' > "$out/result"
