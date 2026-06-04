# Bare Deploy

## 方針

Podman compose を使わず、単一ホスト上で Vicissitude を常駐させるための運用を定義する。

- 実行環境の固定: `flake.nix`
- プロセス管理: Linux は systemd user service、macOS は LaunchAgent
- mutable state / auth: ホスト側の XDG path
- 再デプロイ対象: repo checkout と build artifact

コンテナが担っていた「再現性」と「state の分離」を、Nix とディレクトリ設計へ移す。

## ディレクトリ境界

### Immutable

- repo checkout
- `context/`
- `config/*.json`
- `opencode.json`
- runtime skill 定義
- `deploy/`

### Mutable

- `data/`
- `apps/web/dist`
- `~/.config/vicissitude/secrets.env`
- `~/.config/vicissitude/runtime.env`
- `~/.config/opencode/opencode.json`
- `~/.local/share/opencode/auth.json`
- `~/.local/share/opencode/mcp-auth.json`

`deploy` は `~/.config/opencode` や `~/.local/share/opencode` を作り直さない。初回認証後は service restart / update 後もそのまま維持する。

## 起動構成

bare deploy ではプロセスを 2 つに分ける。

- `vicissitude-bot`: Discord bot 本体と gateway
- `vicissitude-web`: `apps/web/dist` の静的配信

`bot` は `nix run .#vicissitude`、`web` は `nix run .#vicissitude-web` を使う。Linux では headless GL 用に必要なら `Xvfb` を自動起動する。

## セットアップ

### Linux

```bash
nix run .#install-linux
```

これにより以下を行う。

- `~/.config/vicissitude/runtime.env` を生成
- `~/.local/bin/vicissitude-{bot,web,update}` を作成
- `~/.config/systemd/user/vicissitude-{bot,web}.service` を配置
- `bun install --frozen-lockfile` を Nix runtime 上で実行
- `nr validate` と `nr build:web` 相当を Nix 経由で実行
- user service を `enable --now`

ログアウト後も常駐させるには、必要に応じて別途 `sudo loginctl enable-linger <user>` を実行する。

### macOS

```bash
nix run .#install-macos
```

これにより以下を行う。

- `~/.config/vicissitude/runtime.env` を生成
- `~/.local/bin/vicissitude-{bot,web,update}` を作成
- `~/Library/LaunchAgents/dev.ojii3.vicissitude.{bot,web}.plist` を配置
- `bun install --frozen-lockfile` を Nix runtime 上で実行
- `nr validate` と `nr build:web` 相当を Nix 経由で実行
- LaunchAgent を `bootstrap` / `kickstart`

## 更新

```bash
~/.local/bin/vicissitude-update
```

update は次を行う。

1. `main` ブランチかつ clean worktree であることを確認
2. `git fetch` + `git pull --ff-only`
3. `bun install --frozen-lockfile` を含む `nix run .#vicissitude-validate`
4. `bun install --frozen-lockfile` を含む `nix run .#vicissitude-build-web`
5. 既存 service を restart

認証ファイルと `data/` は更新対象に含めない。

## Shell Workspace について

`features.shellWorkspace` は現在も Podman 前提である。Linux では Nix runtime に `podman` を含めるが、macOS では自動セットアップしない。

- Linux: profile を有効化できる
- macOS: `features.shellWorkspace` を無効化するか、別途 Podman 実行環境を用意する
