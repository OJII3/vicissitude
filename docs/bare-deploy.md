# Bare Deploy

## 方針

単一ホスト上で Vicissitude をそのまま動かすための運用を定義する。

- 実行環境の固定: `flake.nix`
- プロセス起動: `nix run`
- mutable state / auth: ホスト側の XDG path
- 再現したいもの: repo checkout、generated config、web build artifact

bare deploy の正本は service manager ではなく Nix app と TypeScript の管理コマンドに置く。foreground 実行は `nix run .#vicissitude`、普段の 1 インスタンス運用は `start/stop/status/restart` コマンド群で扱う。

## ディレクトリ境界

### Immutable

- repo checkout
- `context/`
- `config/*.json`
- `opencode.json`
- runtime skill 定義
- `flake.nix`

### Mutable

- `data/`
- `apps/web/dist`
- `data/context/runtime.json`
- `~/.config/vicissitude/config.json`
- `~/.config/opencode/opencode.json`
- `~/.local/share/opencode/auth.json`
- `~/.local/share/opencode/mcp-auth.json`

認証ファイルと OpenCode state は repo 外に置き、`nix run` を繰り返しても維持する。

## 起動構成

bare deploy の基本コマンドは次の通り。

- `nix run .#vicissitude`
  - `config/default.json` を元に `~/.config/vicissitude/config.json` を生成
  - `models.memory.ollamaBaseUrl` を `http://127.0.0.1:11434` へ差し替える
  - `ollama serve` を子プロセスとして起動する
  - Ollama の readiness を待ち、必要なら embedding model を pull する
  - Discord bot を起動する
- `nix run .#vicissitude-start`
  - bare instance をバックグラウンド起動する
  - すでに同一 instance が動いていれば多重起動せず、そのまま終了する
- `nix run .#vicissitude-stop`
  - bare instance を停止する
- `nix run .#vicissitude-status`
  - bare instance の状態と pid / log path を表示する
- `nix run .#vicissitude-restart`
  - bare instance を再起動する
- `nix run .#vicissitude-web`
  - `apps/web/dist` を静的配信する

`nix run .#vicissitude` と `nix run .#vicissitude-start` は 1 インスタンス制御を共有する。既存 instance が動作中なら 2 個目は起動しない。`ollama` の起動失敗や readiness timeout はエラーとして扱い、その場合 bot は起動しない。

## セットアップ

最初に依存と build を揃える。

```bash
nix run .#vicissitude-validate
nix run .#vicissitude-build-web
```

その後、通常運用では bot を background 起動する。

```bash
nix run .#vicissitude-start
nix run .#vicissitude-web
```

状態確認と停止は次を使う。

```bash
nix run .#vicissitude-status
nix run .#vicissitude-stop
```

`nr bare:start` / `nr bare:stop` / `nr bare:status` / `nr bare:restart` も同じ管理コマンドで、`nix develop -c` の中から使える。

foreground でログを直に見ながら動かしたいときだけ `nix run .#vicissitude` を使う。

## カスタマイズ

bare deploy では次の env を読める。

- `VICISSITUDE_SOURCE_CONFIG_PATH`: 元になる profile。既定値は `config/default.json`
- `VICISSITUDE_CONFIG_PATH`: 生成先 profile。既定値は `~/.config/vicissitude/config.json`
- `VICISSITUDE_OLLAMA_BASE_URL`: bot が参照する Ollama base URL。既定値は `http://127.0.0.1:11434`
- `OLLAMA_HOST`: `ollama serve` が listen する host:port。既定値は `VICISSITUDE_OLLAMA_BASE_URL` から導出
- `VICISSITUDE_WAIT_FOR_OLLAMA_SECONDS`: readiness timeout 秒数。既定値は `60`
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`: state / auth の配置先

background 起動のログは `~/.local/share/vicissitude/logs/bare.log` に追記される。

## Shell Workspace について

`features.shellAgent` は bot プロセス環境（実マシン）で OpenCode 組み込み `bash` を固定ディレクトリ上で動かす。コンテナ隔離は無く、追加の実行環境も不要なので、そのまま動く。
