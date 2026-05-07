## MCP ツール一覧（shell workspace）

> `SHELL_WORKSPACE_ENABLED=true` のインスタンスでのみ利用可能。OpenCode 組み込み `bash` ではなく、隔離された Podman sandbox 内で実行する。

### shell-workspace サーバー

- `shell_start_session(label?, ttl_minutes?)` - TTL 付き workspace session を開始
- `shell_exec(session_id, command, cwd?, timeout_seconds?)` - `/workspace` 配下で shell command を実行
- `shell_status(session_id?)` - session 状態を確認
- `shell_export_file(session_id, path)` - workspace 内ファイルを Discord 添付に使えるローカルパスとして返す
- `shell_stop_session(session_id)` - session を停止し workspace を削除

制約:

- ネットワークアクセス不可
- workspace 以外のファイルシステムは読み取り専用
- host HOME、OpenCode auth、`.env`、SSH/Git 認証情報、Podman socket は sandbox に渡されない
- CPU、メモリ、PID、timeout、出力サイズに上限あり
