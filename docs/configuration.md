# Configuration

## 方針

設定の正本は strict JSON profile にする。JSON を選ぶ理由は、標準パーサで読めること、Zod と JSON Schema のどちらにも対応しやすいこと、デプロイ時に生成・差分確認・検証しやすいことにある。

YAML は採用しない。人間には短く書けるが、暗黙の型変換、重複キー、コメント、パーサごとの差が運用上の曖昧さになるため。

`.env` は secret とデプロイ環境の入口だけに薄く保つ。

## Deploy 時の OpenCode 設定

`nr deploy` は `~/.config/opencode/opencode.json` が regular file として存在する場合だけ、生成 compose override 経由で `/app/.config/opencode/opencode.json` に read-only bind mount する。存在しないホストでは mount を追加しない。

`opencode.json` の位置に directory など regular file 以外がある場合は、誤った bind mount を避けるため deploy を中止する。

## 形式

profile は `config/*.json` に置き、起動時に `VICISSITUDE_CONFIG_PATH=config/default.json` のように指定する。

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

Spotify の推薦プレイリストは secret ではないため `features.spotify.recommendPlaylistId` に書ける。移行中の環境では既存の `SPOTIFY_RECOMMEND_PLAYLIST_ID` も引き続き読み込む。

`features.shellWorkspace.environment` は shell-worker の OpenCode server process に渡す env 名を明示する。値は profile に書かず、`fromEnv` で実行環境の secret env を参照する。たとえば `HUA_GITHUB_TOKEN` を `GH_TOKEN` / `GITHUB_TOKEN` として渡すと、`gh` と GitHub SDK の両方が同じ bot token を利用できる。

compose deploy では `HUA_GITHUB_TOKEN` を bot コンテナの `GH_TOKEN` に写す。OpenCode server と shell-worker の `bash` は bot コンテナの環境を継承するため、`gh` は auth file に依存せず `GH_TOKEN` で認証される。

## パースと検証

profile は `apps/discord/src/profile-config.ts` の Zod schema で検証する。エディタ補完やデプロイ前検証で参照できる JSON Schema は `config/profile.schema.json` に置く。未知の key は拒否する。これにより typo を無視せず、設定ファイルと実行時 config の対応を明確にする。

既存の env loader は移行期間の入口として残すが、新規設定は JSON profile に追加する。次の段階では bootstrap と MCP サーバーの機能出し分けを profile 由来の capability module へ寄せる。
