# Agent Capabilities and Shell Workspace

## 目的

Vicissitude の会話エージェントを、必要な能力だけを持つ profile として組み立てる。Discord で会話するだけのインスタンスには shell 権限を渡さず、作業用インスタンスだけに OpenCode の shell 実行能力を持つサブエージェントを追加する。

shell 実行はメイン会話 agent に直接渡さない。メイン会話 agent は OpenCode `task` ツールだけを使って `shell-worker` サブエージェントへ委譲し、`shell-worker` だけが OpenCode 組み込み `bash` を使う。

## Capability

| Capability         | 内容                                                 | 既定                                 |
| ------------------ | ---------------------------------------------------- | ------------------------------------ |
| `core`             | Discord 送信、返信、リアクション、記憶、リマインダー | 有効                                 |
| `webfetch`         | OpenCode 組み込み `webfetch`                         | 有効                                 |
| `minecraft-bridge` | Discord から Minecraft エージェントへの委譲          | `features.minecraft` 設定時のみ      |
| `shell-workspace`  | OpenCode `bash` を使う `shell-worker` subagent       | `features.shellWorkspace` 設定時のみ |

`shell-workspace` が無効な profile では、`task`、`bash`、ツール説明コンテキストを注入しない。有効な profile では、メイン会話 agent は `task` のみを primary tool として持ち、`build` primary agent の permission は `bash: deny` にする。

## Shell Workspace

`shell-worker` は OpenCode builtin `bash` で作業する。OpenCode session operation には専用 `directory` を渡し、作業ディレクトリを `data/shell-workspaces/opencode/<agent-id>/` に固定する。

作業ディレクトリは永続化対象の `data/shell-workspaces` 配下なので、bot restart 後もファイルは残る。作成ファイルを Discord に添付する場合は、`shell-worker` が workspace 配下に保存した絶対 path を返し、メイン会話 agent が `discord_send_message(..., file_path)` に指定する。

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

shell workspace は JSON profile の `features.shellWorkspace` が存在する場合だけ有効になる。モデル、image、TTL、timeout、network profile は同じ section に書く。disabled profile では section ごと省略する。

`shell-workspace` 有効時、core MCP には `DISCORD_ATTACHMENT_ALLOWED_DIRS` として `data/shell-workspaces` を渡す。これにより workspace 配下の生成ファイルを Discord に添付できる。

JSON profile の `features.shellWorkspace.environment` には shell-worker と shell workspace 子コンテナへ渡す env 名を宣言できる。secret の実値は profile に書かず、`{ "fromEnv": "HUA_GITHUB_TOKEN" }` のように bot コンテナの環境変数を参照する。参照元 env が未設定の場合は起動時にエラーにする。`GH_TOKEN` / `GITHUB_TOKEN` を渡すと、子コンテナ内の `gh` と Git HTTPS credential helper が同じ token を使う。

Podman mount source としてホスト側 path が必要な profile では `features.shellWorkspace.hostDataDir` に書く。OpenCode shell subagent 経路だけなら省略する。

## Background Task Failure Handling

`features.shellWorkspace.backgroundSubagents: true` では、メイン会話 agent が OpenCode `task(background=true)` と `task_status` を使える。OpenCode が返す `task` / `task_status` 出力、または `Background task completed` synthetic text に次のどちらかが含まれる場合、Vicissitude は shell-worker の失敗として扱う。

- `state: error` または `<task_error>...</task_error>`
- `<task_result></task_result>` が空

失敗を検知した場合、Runner は失敗内容を内部メッセージとして積む。Discord 送信など巻き戻せない副作用がまだ始まっていなければ現在の turn を abort し、元のユーザー依頼と失敗内容を合わせて再プロンプトする。これにより、shell-worker が実際には動いていないのに「開始した」「成功した」と報告することを避ける。

## 非目標

- メイン会話 agent への builtin `bash` 直接許可。
- host HOME や auth files の調査、編集、添付。
- ユーザー本人の認証情報を使った GitHub、SSH 操作。
- OpenCode `bash` を Podman sandbox 相当の隔離境界として扱うこと。
