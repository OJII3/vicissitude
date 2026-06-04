# Bare Deploy

## 方針

Podman compose を使わず、単一ホスト上で Vicissitude をそのまま動かすための運用を定義する。

- 実行環境の固定: `flake.nix`
- プロセス起動: `nix run`
- mutable state / auth: ホスト側の XDG path
- 再現したいもの: repo checkout、generated config、web build artifact

bare deploy の正本は service manager ではなく Nix app に置く。`nix run .#vicissitude` が Ollama 起動、bare deploy 用 config 生成、bot 起動までをまとめて行う。

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
- `~/.config/vicissitude/config.json`
- `~/.config/opencode/opencode.json`
- `~/.local/share/opencode/auth.json`
- `~/.local/share/opencode/mcp-auth.json`

認証ファイルと OpenCode state は repo 外に置き、`nix run` を繰り返しても維持する。

## 起動構成

bare deploy の基本コマンドは 2 つだけ。

- `nix run .#vicissitude`
  - `config/default.json` を元に `~/.config/vicissitude/config.json` を生成
  - `models.memory.ollamaBaseUrl` を `http://127.0.0.1:11434` へ差し替える
  - `ollama serve` を子プロセスとして起動する
  - Ollama の readiness を待ち、必要なら embedding model を pull する
  - Discord bot を起動する
- `nix run .#vicissitude-web`
  - `apps/web/dist` を静的配信する

`nix run .#vicissitude` は `ollama` の起動失敗や readiness timeout をエラーとして扱い、その場合 bot は起動しない。

## セットアップ

最初に依存と build を揃える。

```bash
nix run .#vicissitude-validate
nix run .#vicissitude-build-web
```

その後、必要なプロセスを起動する。

```bash
nix run .#vicissitude
nix run .#vicissitude-web
```

常駐管理は repo では持たない。必要なら `tmux` や手元の process manager で包むが、Vicissitude 自体の正本はあくまで上の Nix app とする。

## カスタマイズ

bare deploy では次の env を読める。

- `VICISSITUDE_SOURCE_CONFIG_PATH`: 元になる profile。既定値は `config/default.json`
- `VICISSITUDE_CONFIG_PATH`: 生成先 profile。既定値は `~/.config/vicissitude/config.json`
- `VICISSITUDE_OLLAMA_BASE_URL`: bot が参照する Ollama base URL。既定値は `http://127.0.0.1:11434`
- `OLLAMA_HOST`: `ollama serve` が listen する host:port。既定値は `VICISSITUDE_OLLAMA_BASE_URL` から導出
- `VICISSITUDE_WAIT_FOR_OLLAMA_SECONDS`: readiness timeout 秒数。既定値は `60`
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`: state / auth の配置先

## Shell Workspace について

`features.shellWorkspace` は現在も Podman 前提である。bare deploy で bot を直接起動しても、この feature を使うなら Podman 実行環境は別途必要になる。
