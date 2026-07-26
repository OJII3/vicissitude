# Vicissitude Staging Validation Design

Date: 2026-07-25
Status: Implemented and verified offline

## 1. Purpose

Phase 1の本番前確認のうち、外部credentialを使わずに検証できる範囲をNix checkとして固定する。対象はNix package、PostgreSQL backup/restore、migration checksum、runtime role/ACL、監査とのlinkageである。

この検証はlive Discord/provider接続やproduction CharacterDefinitionの承認を代替しない。offline checkが成功してもDiscord replyは有効にしない。

## 2. Scope

### Included

- PostgreSQL 17のカスタム形式backup作成と3 cluster restore rehearsal
- dump checksum、contents list、migration checksum、audit linkageの検証
- migrator、Gateway、worker用PostgreSQL roleの権限分離とpositive/negative probe
- Gateway、worker、adminの3 executableを提供するNix packageのbuild
- GitHub ActionsでのNix checkと既存validationの再実行
- 検証済み範囲と未検証範囲のREADME、architectureの実装状況への反映

### Excluded

- live Discord login、command registration、message送受信
- provider credentialの有効性、quota、model response品質
- 本番用CharacterDefinitionの内容と人格review
- 本番backup artifact、本番host、外部credential、実運用のprocess境界
- 実運用の起動、restart、sandbox、Unix user、secret配布、hardening

## 3. Distribution and runtime contract

配布単位はNix packageだけとする。packageは次の3 executableを提供する。

- `vicissitude-gateway`: Discord tokenとGateway用database接続設定を必要とする
- `vicissitude-worker`: worker用database接続設定、worker ID、CharacterDefinition ID、model routes、選択したprovider credentialを必要とする
- `vicissitude-admin`: 管理操作とmigration適用に必要なadmin/migrator用database接続設定を必要とする

各executableは、設定を受け取る環境変数名と非secret設定の契約を定義する。packageは実運用の環境隔離、secretの注入、credentialのファイル権限、processの起動・restart・sandboxを検証しない。今回のoffline stagingではこの境界を実行環境として検証しない。

## 4. Flake outputs

flakeは次のoutputだけをstaging対象として提供する。

- `packages.<system>.default`: Gateway、worker、admin CLIを提供するbuild済みpackage
- `checks.x86_64-linux.staging-db-rehearsal`: PostgreSQL backup/restore、role/ACL、checksum、audit linkage検査

package sourceは`lib.fileset.gitTracked`で作り、pnpm dependency hashは`sha256-ROaLBdp08Bl4p6hns6u6l5t4wJROECCLxBFvkZcs9us=`を使う。staging checkはx86_64-linuxだけに公開する。

## 5. Database rehearsal

`staging-db-rehearsal`はNix sandbox内だけで実行する。hostのPostgreSQL instanceやbackup directoryは使わない。

### 5.1 Source database

1. PostgreSQL 17 clusterを初期化する。
2. `vicissitude_migrator`、`vicissitude_gateway`、`vicissitude_worker` roleを作る。
3. 空DBを`pg_dump --create --format=custom`でbackupし、`pg_restore --list`を成功させる。dump fileのinteger mtimeをUTC ISO 8601へ変換し、admin executableの`--backup-confirmed-at`へ渡して初回migrationを適用する。
4. 別clusterへmigration前backupを`pg_restore --create --exit-on-error`でrestoreし、artifact自体が復元できることを確認する。
5. migration後にruntime roleのdatabase、schema、table ACLを適用する。
6. test-only CharacterDefinition、event、job、decision、model call、effect、audit fixtureを投入する。
7. populated DBをcustom-formatでbackupする。
8. 一時manifestへmigration前dumpとpopulated dumpを記録する。各項目はSHA-256、mtime、`pg_restore --list`を持ち、manifest全体に`schema_migrations`のversion/checksumとmigration audit linkageを記録する。

### 5.2 Restore databases

1. migration前artifact用とpopulated artifact用に、別々の空clusterを初期化する。
2. sourceと同じrole属性を作り、maintenance databaseへ接続して各dumpを`pg_restore --create --exit-on-error`でrestoreする。
3. migration前restoreではdatabase/schema ownerとrole属性を確認し、sourceとpopulated restoreではtable ownerとACLを含む完全なcatalog snapshotを比較する。
4. migration前restoreではcustom dumpがrestore可能で、空schemaであることだけを確認する。
5. sourceとpopulated restoreでprimary key、unique/check constraint、指定された7 index、fixture間のforeign-key linkageを確認する。
6. sourceとpopulated restoreでruntime roleのpositive/negative probeを実行する。
7. dump hash、mtime、contents list、migration checksum、`migration.applied` auditの`backupConfirmedAt`をmanifestと照合する。

dumpとmanifestはcheck中だけ保持し、Nix store outputには`staging-db-rehearsal: PASS`の一行だけを残す。secret、connection string、fixture本文、URL、dump本文は出力しない。

## 6. Database roles

`vicissitude_migrator`はschema owner兼admin executable用roleとし、runtime executableへ渡さない。Gatewayとworkerはlogin可能な非owner roleにする。

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

実装時にはrepositoryが実際に発行するSQLを基準に必要権限を確認する。権限を広げる場合は、失敗した具体的なstatementと必要性をtest名に残す。各roleの通常経路をpositive probeで実行し、表にない操作、DDL、role変更、他role専用データ変更はnegative probeで拒否されることを確認する。

role作成時の属性、role membership、PUBLICのdatabase/schema権限、owner、default privilegesをsourceとrestoreで比較する。`gen_random_uuid()`はruntime roleのpositive probe、advisory lockはadmin executableによるmigration適用で確認する。

## 7. CI and documentation status

CIは既存quality jobのNode validationを維持し、新しいstaging jobでは`nix build .#default`と`nix build .#checks.x86_64-linux.staging-db-rehearsal`だけを実行する。actionlintとREADME/architectureのstatus確認は既存qualityまたはlocal verificationで行う。real credentialや外部service接続は使わない。

Verified offline:

- package buildと3 executableの存在
- PostgreSQL 17 custom-format backup/restore、contents list、SHA-256、integer mtime、migration checksum、ISO 8601 audit linkage
- runtime roleの属性、owner、ACL、positive/negative operation boundary

Not verified:

- live Discord/provider、本番CharacterDefinition、本番backup、本番host
- 実運用のcredential配布、environment isolation、process境界、hardening

## 8. Acceptance criteria

- `nix build .#default`が成功し、Gateway、worker、adminの3 executableが存在する。
- `nix build .#checks.x86_64-linux.staging-db-rehearsal`がsource、migration前restore、populated restoreの3 cluster rehearsalを完了する。migration前restoreではcustom dumpのrestore可能性と空schemaだけを確認し、ACL/index/fixture probeはsourceとpopulated restoreだけで実行する。
- role/ACL positive/negative probe、owner、index、fixture linkage、migration checksum、audit linkageが成功する。
- `nix develop -c pnpm validate`、`nix develop -c pnpm build`、`nix flake check`、actionlintが成功する。
- READMEとarchitecture statusがoffline verifiedとlive unverifiedを区別する。

## 9. Follow-up

production CharacterDefinitionとlive credentialは別設計で扱う。承認前はstagingでもmention capabilityを有効にしない。
