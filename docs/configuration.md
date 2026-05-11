# Configuration

## 方針

設定の正本は strict JSON profile にする。JSON を選ぶ理由は、標準パーサで読めること、Zod と JSON Schema のどちらにも対応しやすいこと、デプロイ時に生成・差分確認・検証しやすいことにある。

YAML は採用しない。人間には短く書けるが、暗黙の型変換、重複キー、コメント、パーサごとの差が運用上の曖昧さになるため。

`.env` は secret とデプロイ環境の入口だけに薄く保つ。非 secret の機能設定、モデル選択、ポート、タイムアウト、feature の有効化は profile に置く。

## Deploy 時の OpenCode 設定

`nr deploy` は `~/.config/opencode/opencode.json` が regular file として存在する場合だけ、生成 compose override 経由で `/app/.config/opencode/opencode.json` に read-only bind mount する。存在しないホストでは mount を追加しない。

`opencode.json` の位置に directory など regular file 以外がある場合は、誤った bind mount を避けるため deploy を中止する。

生成 compose override は root `package.json` の workspaces から各 workspace の `node_modules` volume も生成する。`installer` が isolated linker 用 symlink を書き込み、`builder` と `bot` は同じ volume を read-only で読む。これにより `packages` / `apps` の source bind mount は read-only のまま維持し、deploy 時にホストの workspace 配下を更新しない。

## 形式

profile は `config/*.json` に置き、起動時に `VICISSITUDE_CONFIG_PATH=config/default.json` のように指定する。`loadConfig` は profile を必須とし、旧 env 由来の非 secret 設定は読み込まない。

disabled feature は key ごと省略する。`enabled: false`、`null`、空文字の placeholder は書かない。enabled feature は必要な値をすべて同じ section に置き、profile 内に「書いても書かなくてもよい」任意値は増やさない。

```json
{
	"ports": {
		"web": 4000,
		"gateway": 4001,
		"opencodeBase": 4096
	},
	"session": {
		"maxAgeHours": 48
	},
	"models": {
		"conversation": {
			"providerId": "github-copilot",
			"modelId": "big-pickle",
			"temperature": 1
		},
		"heartbeat": {
			"providerId": "github-copilot",
			"modelId": "big-pickle",
			"temperature": 0.7
		},
		"memory": {
			"providerId": "github-copilot",
			"modelId": "gpt-4o",
			"ollamaBaseUrl": "http://ollama:11434",
			"embeddingModel": "embeddinggemma"
		},
		"minecraft": {
			"providerId": "github-copilot",
			"modelId": "big-pickle",
			"temperature": 0.7
		}
	},
	"features": {
		"imageRecognition": {
			"providerId": "opencode-go",
			"modelId": "kimi-k2.5"
		},
		"emotionEstimation": {
			"providerId": "opencode-go",
			"modelId": "kimi-k2.6"
		},
		"shellWorkspace": {
			"image": "vicissitude-code-exec",
			"agent": {
				"providerId": "openai",
				"modelId": "gpt-5.4",
				"temperature": 0.4,
				"steps": 24
			},
			"environment": {
				"GH_TOKEN": { "fromEnv": "HUA_GITHUB_TOKEN" },
				"GITHUB_TOKEN": { "fromEnv": "HUA_GITHUB_TOKEN" }
			},
			"hostDataDir": "/home/hua/vicissitude/data/shell-workspaces",
			"networkProfile": "open",
			"defaultTtlMinutes": 60,
			"maxTtlMinutes": 120,
			"defaultTimeoutSeconds": 30,
			"maxTimeoutSeconds": 120,
			"maxOutputChars": 50000
		}
	}
}
```

## Secrets

次の値は profile に書かない。

| feature       | env                                                                   |
| ------------- | --------------------------------------------------------------------- |
| Discord       | `DISCORD_TOKEN`                                                       |
| Spotify       | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` |
| Genius        | `GENIUS_ACCESS_TOKEN`                                                 |
| GitHub Issues | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`                         |
| shell-worker  | `HUA_GITHUB_TOKEN`                                                    |

feature section が存在する場合だけ、その feature の secret env を必須にする。

Spotify の推薦プレイリストは secret ではないため `features.spotify.recommendPlaylistId` に書く。`SPOTIFY_RECOMMEND_PLAYLIST_ID` は profile 正本化に伴い読み込まない。

`features.shellWorkspace.environment` は shell-worker の OpenCode server process と shell workspace 子コンテナへ渡す env 名を明示する。値は profile に書かず、`fromEnv` で実行環境の secret env を参照する。たとえば `HUA_GITHUB_TOKEN` を `GH_TOKEN` / `GITHUB_TOKEN` として渡すと、`gh` と GitHub SDK の両方が同じ bot token を利用できる。

`features.shellWorkspace.hostDataDir` は shell workspace 用 MCP server が Podman mount source として使うホスト側 path を必要とする場合だけ profile に書く。OpenCode shell subagent 経路だけを使う profile では省略する。

compose deploy では `HUA_GITHUB_TOKEN` を bot コンテナの `GH_TOKEN` に写す。OpenCode server と shell-worker の `bash` は bot コンテナの環境を継承するため、`gh` は auth file に依存せず `GH_TOKEN` で認証される。shell workspace 子コンテナでは `GH_TOKEN` / `GITHUB_TOKEN` がある場合だけ Git HTTPS credential helper を env 経由で追加し、`git push` も同じ token を使う。

## パースと検証

profile は `apps/discord/src/profile-config.ts` の Zod schema で検証する。エディタ補完やデプロイ前検証で参照できる JSON Schema は `config/profile.schema.json` に置く。未知の key は拒否する。これにより typo を無視せず、設定ファイルと実行時 config の対応を明確にする。

感情推定は `features.emotionEstimation` が存在する場合だけ有効になる。通常の OpenCode provider を使う場合は `providerId` と `modelId` を指定する。Ollama chat API を使う場合だけ `providerId: "ollama"` とし、同じ section に `ollamaBaseUrl` を指定する。

新規設定は JSON profile に追加する。bootstrap と MCP サーバー間で渡す env はプロセス境界の内部プロトコルとして扱い、ユーザーが設定する正本にはしない。

heartbeat 専用エージェントの OpenCode 設定は `models.heartbeat` に置く。通常の guild 応答は `models.conversation` を使い、heartbeat は自律行動の抑制を効かせやすいように別 temperature を指定できる。
