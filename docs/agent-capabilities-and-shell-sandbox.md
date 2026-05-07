# Agent Capabilities and Shell Workspace

## 目的

Vicissitude の会話エージェントを、必要な能力だけを持つ profile として組み立てる。Discord で会話するだけのインスタンスには shell 権限を渡さず、作業用インスタンスだけに OpenCode の shell 実行能力を持つサブエージェントを追加する。

shell 実行はメイン会話 agent に直接渡さない。メイン会話 agent は OpenCode `task` ツールだけを使って `shell-worker` サブエージェントへ委譲し、`shell-worker` だけが OpenCode 組み込み `bash` を使う。

## Capability

| Capability         | 内容                                                 | 既定                                    |
| ------------------ | ---------------------------------------------------- | --------------------------------------- |
| `core`             | Discord 送信、返信、リアクション、記憶、リマインダー | 有効                                    |
| `webfetch`         | OpenCode 組み込み `webfetch`                         | 有効                                    |
| `minecraft-bridge` | Discord から Minecraft エージェントへの委譲          | `MC_HOST` 設定時のみ                    |
| `shell-workspace`  | OpenCode `bash` を使う `shell-worker` subagent       | `SHELL_WORKSPACE_ENABLED=true` の時のみ |

`shell-workspace` が無効な profile では、`task`、`bash`、ツール説明コンテキストを注入しない。有効な profile では、メイン会話 agent は `task` のみを primary tool として持ち、`build` primary agent の permission は `bash: deny` にする。

## Shell Workspace

`shell-worker` は OpenCode builtin `bash` で作業する。OpenCode session operation には専用 `directory` を渡し、作業ディレクトリを `data/shell-workspaces/opencode/<agent-id>/` に固定する。

作業ディレクトリは永続化対象の `data/shell-workspaces` 配下なので、bot restart 後もファイルは残る。作成ファイルを Discord に添付する場合は、`shell-worker` が workspace 配下に保存した絶対 path を返し、メイン会話 agent が `core_send_message(..., file_path)` に指定する。

## Permission Policy

既定 policy:

- メイン会話 agent:
  - `task: allow`
  - `bash: deny`
  - `external_directory: deny`
- `shell-worker` subagent:
  - `bash: allow`
  - `task: deny`
  - `external_directory: deny`
- OpenCode の global builtin tool は `webfetch`、`task`、shell workspace 有効時の `bash` だけを開く。
- `primary_tools` は `["task"]` にし、メイン会話 agent の入口を委譲に限定する。
- `shell-worker` prompt では workspace 外の読み書き、host secrets、auth files、環境変数 dump、権限昇格を禁止する。

これは OpenCode permission と作業ディレクトリによる制御であり、Podman sandbox のような OS-level isolation ではない。OpenCode `bash` を使う以上、実行プロセスは bot コンテナのユーザー権限と network の範囲で動く。

## 設定

| 環境変数                                  | 既定                    | 説明                                                            |
| ----------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `SHELL_WORKSPACE_ENABLED`                 | `false`                 | `true`/`1`/`yes`/`on` で有効化                                  |
| `SHELL_WORKSPACE_IMAGE`                   | `vicissitude-code-exec` | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_NETWORK_PROFILE`         | `open`                  | 互換設定。OpenCode shell 経路では bot コンテナ側 network に従う |
| `SHELL_WORKSPACE_DEFAULT_TTL_MINUTES`     | `60`                    | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_MAX_TTL_MINUTES`         | `120`                   | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_DEFAULT_TIMEOUT_SECONDS` | `30`                    | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_MAX_TIMEOUT_SECONDS`     | `120`                   | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_MAX_OUTPUT_CHARS`        | `50000`                 | 互換設定。OpenCode shell 経路では使用しない                     |
| `SHELL_WORKSPACE_AGENT_PROVIDER_ID`       | `OPENCODE_PROVIDER_ID`  | `shell-worker` サブエージェントの provider                      |
| `SHELL_WORKSPACE_AGENT_MODEL_ID`          | `OPENCODE_MODEL_ID`     | `shell-worker` サブエージェントの model                         |
| `SHELL_WORKSPACE_AGENT_TEMPERATURE`       | `0.7`                   | `shell-worker` サブエージェントの temperature                   |
| `SHELL_WORKSPACE_AGENT_STEPS`             | `24`                    | `shell-worker` サブエージェントの最大 agentic step 数           |
| `SHELL_WORKSPACE_HOST_DATA_DIR`           | unset                   | 互換設定。OpenCode shell 経路では使用しない                     |

`shell-workspace` 有効時、core MCP には `DISCORD_ATTACHMENT_ALLOWED_DIRS` として `data/shell-workspaces` を渡す。これにより workspace 配下の生成ファイルを Discord に添付できる。

## 非目標

- メイン会話 agent への builtin `bash` 直接許可。
- host HOME や auth files の調査、編集、添付。
- ユーザー本人の認証情報を使った GitHub、Spotify、SSH 操作。
- OpenCode `bash` を Podman sandbox 相当の隔離境界として扱うこと。
