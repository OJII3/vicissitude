# Agent Capabilities and Shell Sandbox

## 目的

Vicissitude の会話エージェントを、必要な能力だけを持つ profile として組み立てる。Discord で会話するだけのインスタンスには shell 権限を渡さず、作業用インスタンスだけに隔離された shell workspace を MCP 経由で接続する。

OpenCode 組み込み `bash` は使わない。shell 実行は `shell-workspace` MCP サーバーに集約し、timeout、cwd、ネットワーク profile、quota、監査ログ、TTL をアプリケーション側で強制する。

## Capability

初期実装の capability は次の通り。

| Capability         | 内容                                                 | 既定                                    |
| ------------------ | ---------------------------------------------------- | --------------------------------------- |
| `core`             | Discord 送信、返信、リアクション、記憶、リマインダー | 有効                                    |
| `webfetch`         | OpenCode 組み込み `webfetch`                         | 有効                                    |
| `minecraft-bridge` | Discord から Minecraft エージェントへの委譲          | `MC_HOST` 設定時のみ                    |
| `shell-workspace`  | Podman sandbox 内の shell workspace                  | `SHELL_WORKSPACE_ENABLED=true` の時のみ |

`shell-workspace` が無効な profile では、MCP サーバーもツール説明コンテキストも注入しない。

## Shell Workspace

`shell-workspace` は、短いコード片実行ではなく、TTL 付きの workspace session を提供する。MVP では exec ごとに sandbox コンテナを起動し、session ごとの workspace directory を bind mount して状態を保持する。

提供ツール:

- `shell_start_session(label?, ttl_minutes?)`
- `shell_exec(session_id, command, cwd?, timeout_seconds?)`
- `shell_status(session_id?)`
- `shell_export_file(session_id, path)`
- `shell_stop_session(session_id)`

## Sandbox Policy

既定 policy:

- rootless Podman で prebuilt image を実行する。
- network は `open` を既定にし、rootless Podman の `pasta` でインターネットアクセスを許可する。必要なら `SHELL_WORKSPACE_NETWORK_PROFILE=none` で無効化できる。
- root filesystem は read-only。
- session workspace だけを `/workspace` に read-write mount する。
- sandbox 内の `HOME`、XDG cache/config、`TMPDIR` は `/workspace` 配下に向け、session ごとに作成する。
- host HOME、OpenCode auth、`.env`、SSH/Git credential、Podman socket は sandbox に渡さない。
- 環境変数は shell MCP プロセス、sandbox 実行の両方で allowlist 方式にする。
- non-root user で実行する。
- `--cap-drop=ALL` と `--security-opt=no-new-privileges` を設定する。
- CPU、memory、PID、timeout、output size を制限する。
- session TTL と明示停止で workspace を削除する。

## 設定

| 環境変数                                  | 既定                    | 説明                                                                  |
| ----------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `SHELL_WORKSPACE_ENABLED`                 | `false`                 | `true`/`1`/`yes`/`on` で有効化                                        |
| `SHELL_WORKSPACE_IMAGE`                   | `vicissitude-code-exec` | Podman で起動する sandbox image                                       |
| `SHELL_WORKSPACE_NETWORK_PROFILE`         | `open`                  | `open` はインターネット許可、`none` はネットワーク無効                |
| `SHELL_WORKSPACE_DEFAULT_TTL_MINUTES`     | `60`                    | session の既定 TTL                                                    |
| `SHELL_WORKSPACE_MAX_TTL_MINUTES`         | `120`                   | session TTL 上限                                                      |
| `SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS` | `30`                    | `shell_exec` の既定 timeout                                           |
| `SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS`     | `120`                   | `shell_exec` timeout 上限                                             |
| `SHELL_WORKSPACE_MAX_OUTPUT_CHARS`        | `50000`                 | stdout + stderr の返却上限                                            |
| `SHELL_WORKSPACE_HOST_DATA_DIR`           | unset                   | ホスト Podman socket 経由で実行する場合のホスト側 workspace directory |

`shell-workspace` 有効時、core MCP には `DISCORD_ATTACHMENT_ALLOWED_DIRS` として shell workspace directory を渡す。これにより `shell_export_file` が返したパスを `core_send_message(..., file_path)` で添付できる。

bot コンテナからホスト Podman socket を使う deploy では、sandbox の bind mount source はホスト側 path である必要がある。この場合は `SHELL_WORKSPACE_HOST_DATA_DIR` にホスト側の `data/shell-workspaces` を指定し、MCP プロセスが管理・添付に使う `SHELL_WORKSPACE_DATA_DIR` とは分ける。

## 監査ログ

`shell_exec` ごとに JSON Lines で監査ログを保存する。

記録項目:

- `timestamp`
- `agent_id`
- `session_id`
- `command`
- `cwd`
- `exit_code`
- `duration_ms`
- `timed_out`
- `output_truncated`

## 非目標

- OpenCode 組み込み `bash` の有効化。
- host checkout や host HOME の直接編集。
- ユーザー本人の認証情報を使った GitHub、Spotify、SSH 操作。
- host network、privileged container、Podman socket の sandbox への直接 mount。
