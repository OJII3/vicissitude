# Vicissitude Staging Validation Design

Date: 2026-07-25
Status: Approved for planning

## 1. Purpose

Phase 1の本番前確認のうち、外部credentialを使わずに検証できる範囲をNix checkとして固定する。対象はbackup/restore、PostgreSQL role、systemd serviceとcredentialの分離である。

この検証はlive Discord/provider接続やproduction CharacterDefinitionの承認を代替しない。offline checkが成功してもDiscord replyは有効にしない。

## 2. Scope

### Included

- PostgreSQL 17のカスタム形式バックアップ作成と復元試験
- dump checksum、contents list、migration checksumの検証
- restore後のschema、constraint、index、fixture、audit linkageの検査
- migrator、Gateway、worker用PostgreSQL roleの権限分離
- GatewayとworkerのUnix user、systemd unit、credential fileの分離
- systemd hardening設定
- GitHub Actionsでの再実行
- 検証済み範囲と未検証範囲のREADME、architectureの実装状況への反映

### Excluded

- live Discord login、command registration、message送受信
- provider credentialの有効性、quota、model response品質
- 本番用CharacterDefinitionの内容と人格review
- production hostへのNixOS configuration適用
- production backup artifactからのrestore

## 3. Flake Outputs

flakeは次のoutputを提供する。

- `packages.<system>.default`: build済みのGateway、worker、admin CLIを提供するpackage
- `nixosModules.vicissitude`: productionとVM testで共有するservice module
- `checks.x86_64-linux.staging-db-rehearsal`: PostgreSQL backup/restoreとrole検査
- `checks.x86_64-linux.staging-systemd-boundary`: NixOS VMによるuser、unit、credential境界検査

NixOS VM testはproduction TypeScriptへfake adapterを追加しない。moduleの`package` optionへ同じexecutable名を持つtest probe packageを渡し、service wiringだけを検査する。実packageのbuildとTypeScript runtimeは既存のunit、PostgreSQL spec、E2Eで検査する。

## 4. Database Rehearsal

`staging-db-rehearsal`はNix sandbox内だけで実行する。hostのPostgreSQL instanceやbackup directoryは使わない。

### 4.1 Source Database

1. PostgreSQL 17 clusterを初期化する。
2. `vicissitude_migrator`、`vicissitude_gateway`、`vicissitude_worker` roleを作る。
3. 空DBを`pg_dump --create --format=custom`でbackupする。`pg_restore --list`成功後にdump fileのmtimeをbackup完了時刻として`BACKUP_CONFIRMED_AT`へ設定し、初回migrationをadmin CLIから適用する。
4. 別clusterへsourceと同じ属性のroleを作る。手順3のmigration前backupをそのclusterのmaintenance databaseへ`pg_restore --create --exit-on-error`でrestoreし、migration前artifact自体が復元できることを確認する。
5. runtime roleのdatabase、schema、table ACLを適用する。
6. test-only CharacterDefinition、event、job、decision、model call、effect、audit fixtureを投入する。
7. populated DBを`pg_dump --create --format=custom`でbackupする。
8. 一時manifestへmigration前dumpとpopulated dumpを別項目として記録する。各項目はSHA-256、file mtime、`pg_restore --list`を持ち、manifest全体に`schema_migrations`のversion/checksumを記録する。

test-only CharacterDefinitionは日本語schemaとrepository動作のfixtureであり、production personaとして扱わない。

### 4.2 Restore Database

1. 別の空clusterを初期化し、sourceと同じ属性のroleだけを先に作る。
2. maintenance databaseへ接続し、`pg_restore --create --exit-on-error`でdatabase、owner、ACLを含めてrestoreする。
3. 一時manifestのmigration version/checksumとrestore先を比較する。
4. primary key、unique constraint、check constraintに加え、`one_production_character_version`、`events_expires_at_idx`、`events_scope_time_idx`、`jobs_claim_idx`、`effects_claim_idx`、`audit_entries_run_idx`、`audit_entries_effect_idx`を確認する。
5. `pg_database.datdba`、`pg_namespace.nspowner`、`pg_class.relowner`でownerを比較する。`information_schema.role_table_grants`、`has_database_privilege`、`has_schema_privilege`、`has_table_privilege`でACLを比較する。
6. `jobs.event_id`、`decision_runs.job_id/event_id`、`model_calls.run_id`、`effects.run_id`、`audit_entries.event_id/job_id/run_id/effect_id`がfixtureのIDと一致することを確認する。
7. restore先で5章のpositive testを実行し、UUID生成、constraint、repository transactionが正常に動くことを確認する。

rehearsal outputにはsecretやconnection stringを含めない。dumpと一時manifestはcheck中だけ保持し、Nix store outputへ残さない。custom dumpのhashと作成時刻は実行ごとに変わるため、`$out`には決定的な成功markerと検証項目名だけを残す。

このcheckが検証するのは、operatorがbackupを作成し、contents listを確認してから、dump mtimeをbackup完了時刻としてCLIへ渡す運用手順である。migration前dumpのmtimeがmigration lock取得時刻以前かつ24時間以内であり、`migration.applied` auditの`backupConfirmedAt`と一致することを確認する。両dumpはrestore前後でSHA-256が変わらず、各mtimeがcheck開始時刻以上、検証時刻以下であることを確認する。現行CLIはartifact IDやhashを受け取らないため、虚偽のattestationを防ぐ保証は行わない。

## 5. Database Roles

`vicissitude_migrator`はschema owner兼admin CLI用roleとし、runtime serviceへ渡さない。Gatewayとworkerはlogin可能な非owner roleにする。

| Table | Gateway | Worker | Migrator |
| --- | --- | --- | --- |
| `schema_migrations` | SELECT | SELECT | ALL |
| `system_state` | SELECT | SELECT | ALL |
| `channel_capabilities` | SELECT, INSERT, UPDATE | none | ALL |
| `events` | SELECT, INSERT | SELECT | ALL |
| `jobs` | INSERT | SELECT, UPDATE | ALL |
| `character_definitions` | none | SELECT | ALL |
| `decision_runs` | none | SELECT, INSERT, UPDATE | ALL |
| `model_calls` | none | INSERT | ALL |
| `effects` | SELECT, UPDATE | SELECT, INSERT | ALL |
| `audit_entries` | INSERT | INSERT | ALL |

実装時にはrepositoryが実際に発行するSQLを基準に必要権限を確認する。権限を広げる場合は、失敗した具体的なstatementと必要性をtest名に残す。

Positive testは各serviceの通常経路をrole別connectionで実行する。権限表に記載した各権限を少なくとも1回使い、次のtest IDで結果を記録する。

- `gateway_migration_read`
- `gateway_channel_patch`
- `gateway_event_ingest`
- `gateway_effect_execute`
- `worker_migration_read`
- `worker_job_claim`
- `worker_character_read`
- `worker_decision_complete`

権限表を期待値として、Gatewayとworkerの全tableについて`SELECT`、`INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`REFERENCES`、`TRIGGER`の実効権限を比較する。表にない権限はすべてfalseでなければならない。`none`セルではSELECTと書込みがpermission deniedになることも実statementで確認する。加えて次を必須とする。

- Gateway roleによるCharacterDefinition変更、decision/model call書込み、DDLを拒否する。
- Worker roleによるchannel/system変更、event投入、DDLを拒否する。
- 両runtime roleによるmigration適用とrole変更を拒否する。
- Migrator credentialがGateway/worker service環境に存在しないことをVM testで確認する。

role作成時に`LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`を指定し、role membershipを持たせない。sourceとrestoreで`pg_roles`の属性と`pg_auth_members`を比較する。databaseから`PUBLIC`の`CONNECT`と`TEMP`を、application schemaから`PUBLIC`の`CREATE`をrevokeする。runtime roleにはdatabase `CONNECT`とschema `USAGE`だけを明示grantし、temporary tableを含むDDLを拒否する。migratorはdatabase、schema、application objectのownerとする。default privilegesも`PUBLIC`へ開かない。

`gen_random_uuid()`とPostgreSQL advisory lockに必要な組込み関数はruntime roleから実行できることをpositive testで確認する。権限表と非table ACLはmigration後、fixture投入前にsource DBへ適用し、dumpへ収録する。role別positive/negative testはrestore先で実行し、復元されたACLを検証する。

## 6. NixOS Module

`nixosModules.vicissitude`は次の設定を持つ。

- `services.vicissitude.enable`
- `services.vicissitude.package`
- `services.vicissitude.gateway.databaseUrlFile`
- `services.vicissitude.gateway.discordTokenFile`
- `services.vicissitude.worker.databaseUrlFile`
- `services.vicissitude.worker.providerCredentialFiles`
- health port、worker ID、migration pathなどsecretではないprocess設定

`databaseUrlFile`と`discordTokenFile`は、それぞれ値だけを含む1 secret 1 fileのpathである。`providerCredentialFiles`は環境変数名から1 secret 1 fileへのattribute setとする。health portなどの非secret値はmodule optionからsystemd unitの固定引数または固定環境変数へ変換する。

moduleは`vicissitude-gateway`と`vicissitude-worker`を別system userとして作る。home directoryとlogin shellは付与しない。secret fileをEnvironmentFileとして直接読み込まず、systemd `LoadCredential`へkeyごとに渡す。

Gatewayの最終process環境allowlist:

- `DATABASE_URL`
- `DISCORD_TOKEN`
- `VICISSITUDE_GUILD_ID`
- `VICISSITUDE_ADMIN_USER_IDS`
- `VICISSITUDE_GATEWAY_HEALTH_PORT`
- `VICISSITUDE_MIGRATIONS_DIR`
- `LOG_LEVEL`

Workerの最終process環境allowlist:

- `DATABASE_URL`
- 選択したproviderに必要なcredential。example routeでは`OPENAI_API_KEY`
- `VICISSITUDE_WORKER_ID`
- `VICISSITUDE_WORKER_HEALTH_PORT`
- `VICISSITUDE_CHARACTER_ID`
- `VICISSITUDE_MODEL_ROUTES_PATH`
- `VICISSITUDE_MIGRATIONS_DIR`
- `LOG_LEVEL`

入力secret fileはroot所有、mode `0400`とする。unitごとの固定wrapperは`env -i`で親環境を消去し、固定した`PATH`、`NODE_ENV`、上記process環境allowlist、credential directoryから読んだ認識済みkeyだけでappをexecする。VM testのWorkerではprovider keyを`OPENAI_API_KEY`に固定する。Gateway optionはdatabase URLとDiscord token以外のsecret keyを受け取らない。Workerのprovider credential keyは設定したmodel routeに対応する名前をmodule optionで列挙する。任意EnvironmentFileは受け付けない。

systemd managerがcredentialをunit専用directoryへ配置した後、processは指定userで動く。admin/migrator credentialは別fileとし、runtime unitの`LoadCredential`から参照しない。

両unitには最低限、次のhardeningを設定する。

- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=true`
- `UMask=0077`
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`
- `Restart=on-failure`

## 7. NixOS VM Test

VM testではboot後のoneshot serviceが`/run/vicissitude-validation`へGateway、worker、migrator用の異なるrandom dummy markerを生成し、root所有、mode `0400`にする。markerをNix式、store path、journal、assertion messageへ出さない。Gatewayとworker unitはoneshot完了後に起動する。

test probe packageは実packageと同じ`bin/vicissitude-gateway`と`bin/vicissitude-worker`を提供する。各probeは環境変数の値を出力せず、`RuntimeDirectory`配下へ`ready` fileを書いて待機する。VM testはunitがactiveであり、このfileが存在することをready条件とする。

DB rehearsalのtest-only CharacterDefinitionは`characterId=staging-validation`、`version=1`、`language=ja`、固定の日本語system prompt、1件のfailure messageを持つ。model routeはrepositoryの`config/model-routes.example.json`を構文fixtureとして使うが、provider callは行わない。

test probeは次を行う。

1. Gatewayとworker unitが別UIDで起動したことを確認する。
2. `/run`に生成した入力credential fileのownerとmodeを確認する。
3. `/proc/<pid>/environ`から環境変数名だけを取得し、`PATH`、`NODE_ENV`と各processの最終環境allowlistの集合に完全一致することを確認する。
4. Gatewayにprovider/migrator credential名がないことを確認する。
5. WorkerにDiscord/migrator credential名がないことを確認する。
6. `systemctl show`で`NoNewPrivileges=yes`、`PrivateTmp=yes`、`ProtectSystem=strict`、`ProtectHome=yes`、`UMask=0077`、`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`、`Restart=on-failure`を確認する。
7. probe unitがactiveであり、`RuntimeDirectory`の`ready` fileが存在することを確認する。
8. probe unitをtest時だけ`IPAddressDeny=any`で上書きし、外部networkなしで完了することを確認する。
9. boot時に生成したmarker値をtest driver内の変数へ読み、Gateway/worker journal、`systemctl status`出力、VM test output fileに含まれないことを値を表示せず確認する。

外部networkは無効にする。VM testが確認するのはmoduleとservice境界であり、Discordやproviderの可用性ではない。

## 8. CI

既存のNode/PostgreSQL jobとは別に`staging-validation` jobを追加する。

- runnerは`ubuntu-24.04`へ固定する。
- Nix installerは`DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25`（v22）へ固定する。
- permissionsは`contents: read`だけにする。
- `timeout-minutes: 30`を設定する。
- `nix build .#checks.x86_64-linux.staging-db-rehearsal`を実行する。
- `nix build .#checks.x86_64-linux.staging-systemd-boundary`を実行する。
- `nix run nixpkgs#actionlint -- .github/workflows/ci.yml`を実行する。
- どちらかが失敗した場合、PR checkを失敗させる。

CIはreal credentialを持たない。test workloadは外部serviceへ接続しない。checkout、action、Nix input、package dependencyの取得はCI bootstrapとして別に扱う。

## 9. Failure Reporting

checkはfail-closedとする。次のいずれかが起きたら成功outputを作らない。

- `pg_restore --list`またはrestoreが失敗した。
- dump checksum、migration checksum、fixture linkageが一致しない。
- 必要操作がpermission deniedになった。
- 禁止操作が成功した。
- service環境に別processまたはmigratorのcredential名が入った。
- systemd hardening propertyが期待値と異なる。

errorにはcheck名、role名、操作名、期待した許可/拒否だけを含める。credential値、DATABASE_URL、event content、prompt、responseは出力しない。

## 10. Documentation Status

check成功後、READMEとarchitecture statusを次の区分で更新する。

- Verified offline: PostgreSQLのカスタム形式backup/restore、migration checksum、runtime用DB role、systemd user/unit/credential wiring
- Not verified: 本番backup artifact、live Discord/provider credential、本番host deployment、本番用CharacterDefinition

本番稼働条件は変更しない。本番用CharacterDefinitionを独立reviewし、live credential境界と実接続を確認するまでmention capabilityを有効にしない。

## 11. Acceptance Criteria

- 2つのNix checkが、このNixOS x86_64-linux host（Nix 2.34.7、sandbox有効）とGitHub Actionsで成功する。
- 一時manifestで両dumpのhashとmtime、migration前dumpのaudit時刻、migration checksumをcheck中に照合し、`$out`は決定的な成功markerになる。
- role別positive/negative testが成功する。
- VM testが別UID、別credential file、allowlist、hardeningを確認する。
- VM testがruntime markerをjournal、`systemctl status`、test outputから検索し、dummy marker値やconnection stringがないことを確認する。
- READMEとarchitecture statusがoffline verifiedとlive unverifiedを区別する。
- `nix develop -c pnpm validate`、`nix develop -c pnpm build`、`nix flake check`、actionlintが全件成功する。

## 12. Follow-up

staging validation完了後、production CharacterDefinitionを別specで設計する。人格要件、禁止事項、日本語会話例、failure messageをユーザーと決め、候補JSONを別agentが独立reviewする。承認前はstagingでもmention capabilityを有効にしない。
