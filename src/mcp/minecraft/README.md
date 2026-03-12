# Minecraft MCP サーバー

`src/mcp/minecraft/` は mineflayer ベースの独立プロセスとして動作し、StreamableHTTP で Minecraft 操作用 MCP ツールを公開する。
現行実装の正本はコード本体と [`docs/SPEC.md`](/home/ojii3/src/github.com/ojii3/vicissitude/docs/SPEC.md)、[`docs/ARCHITECTURE.md`](/home/ojii3/src/github.com/ojii3/vicissitude/docs/ARCHITECTURE.md)、[`docs/RUNBOOK.md`](/home/ojii3/src/github.com/ojii3/vicissitude/docs/RUNBOOK.md) であり、この README はその要約である。

## 現在の構成

### ファイル構成

```text
src/mcp/minecraft/
├── server.ts              # エントリポイント。接続、MCP、metrics、wake notifier を起動
├── http-server.ts         # 共通 StreamableHTTP サーバーの re-export
├── mcp-tools.ts           # observe/action ツール登録 + ツール呼び出しメトリクス
├── bot-connection.ts      # mineflayer 接続管理
├── bot-context.ts         # BotContext（接続状態、イベントバッファ、行動状態）
├── bot-queries.ts         # 状態観測ヘルパー
├── state-summary.ts       # 観測結果・イベント・ジョブ状態の自然言語整形
├── job-manager.ts         # 非同期ジョブ管理、失敗分類、再試行クールダウン
├── brain-wake.ts          # 緊急イベント時の Minecraft brain wake file 通知
├── mc-metrics.ts          # MC 専用の軽量 Prometheus エクスポータ
├── helpers.ts             # 共有型・表示ヘルパー
└── actions/
    ├── movement.ts        # follow_player, go_to, collect_block, stop
    ├── interaction.ts     # send_chat, equip_item, place_block
    ├── jobs.ts            # craft_item, sleep_in_bed
    ├── combat.ts          # attack_entity
    ├── survival/
    │   ├── food.ts        # eat_food
    │   ├── escape.ts      # flee_from_entity
    │   ├── shelter.ts     # find_shelter
    │   └── index.ts       # survival 系ツール登録
    └── shared.ts          # 共通ヘルパー
```

### 提供ツール

| ツール | 種別 | 説明 |
| --- | --- | --- |
| `observe_state` | 観察 | 現在状態の自然言語要約 |
| `get_recent_events` | 観察 | 直近イベント取得。`importance` でフィルタ可能 |
| `get_job_status` | 観察 | 実行中ジョブ、履歴、クールダウン状態を取得 |
| `get_viewer_url` | 観察 | prismarine-viewer の URL を返す |
| `follow_player` | 行動 | プレイヤー追従 |
| `go_to` | 行動 | 座標移動 |
| `collect_block` | 行動 | ブロック採集 |
| `stop` | 行動 | 現在の移動・追従・ジョブを停止 |
| `craft_item` | 行動 | クラフトジョブを開始 |
| `sleep_in_bed` | 行動 | 就寝ジョブを開始 |
| `equip_item` | 行動 | アイテム装備 |
| `place_block` | 行動 | ブロック設置 |
| `send_chat` | 行動 | ゲーム内チャット送信 |
| `eat_food` | 行動 | 手持ち食料から選んで食べる |
| `flee_from_entity` | 行動 | 指定エンティティから逃走 |
| `find_shelter` | 行動 | 近場の避難場所探索と退避 |
| `attack_entity` | 行動 | 指定エンティティを攻撃 |

## 実装上の挙動

### 状態とイベント

- `BotContext` は mineflayer の bot インスタンス、現在行動、直近イベント最大 100 件を保持する。
- `observe_state` は生の mineflayer オブジェクトを返さず、位置・体力・空腹・周辺エンティティ・装備・インベントリ・最近のイベントを自然言語要約へ変換して返す。
- `get_recent_events` は `low` / `medium` / `high` / `critical` の重要度で絞り込める。

### ジョブ管理

- 長めのアクションは `JobManager` で非同期ジョブとして管理する。
- 同時実行できるジョブは 1 件のみ。新規ジョブ開始時は既存ジョブを `superseded` 扱いでキャンセルする。
- 同じ種類のジョブが 2 回連続で失敗した場合、その種類は既定 60 秒クールダウンされる。
- 失敗理由は `resource shortage` / `pathfinding failure` / `target missing` / `connection failure` / `survival failure` に分類して履歴へ残す。
- `get_job_status` は現在ジョブに加えて履歴とクールダウン中のジョブ種別を返す。

### 緊急 wake 通知

- `MC_BRAIN_WAKE_FILE` が設定されている場合、重要イベント時に wake file を更新して Minecraft brain 側のポーリングを早める。
- 現在 wake 対象になるのは次の条件:
  - `importance` が `high` または `critical`
  - `damage`
  - `health` かつ `importance=medium`
  - `ジョブ失敗:` で始まる `job` イベント

### 観測性

- MC MCP プロセスは独立した Prometheus エンドポイントを持つ。
- 現在のカウンタ:
  - `mc_jobs_total`
  - `mc_bot_events_total`
  - `mc_mcp_tool_calls_total`
- HTTP エンドポイント:
  - `/metrics`
  - `/health`

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `MC_HOST` | yes | - | Minecraft サーバーホスト |
| `MC_PORT` | no | `25565` | Minecraft サーバーポート |
| `MC_USERNAME` | no | `hua` | bot ユーザー名 |
| `MC_VERSION` | no | 自動 | mineflayer 接続バージョン |
| `MC_MCP_PORT` | no | `3001` | MCP HTTP ポート |
| `MC_VIEWER_PORT` | no | `3007` | prismarine-viewer ポート |
| `MC_METRICS_PORT` | no | `9092` | Prometheus metrics ポート |
| `MC_METRICS_HOST` | no | `0.0.0.0` | metrics bind host |
| `MC_BRAIN_WAKE_FILE` | no | - | 緊急時に更新する wake file のパス |

## システム内での役割

- このプロセス自体は低レベル Minecraft 操作を提供する MCP サーバーであり、意思決定はしない。
- 意思決定は別の Minecraft AgentRunner が担当し、SQLite ベースの bridge と `mc-bridge` MCP を介して Discord 側と連携する。
- 2026-03-12 時点の全体方針は、単一 Minecraft エージェントを将来的に `Observer` / `Planner` / `Executor` / `Critic` / `Social` へ責務分割できる形へ進めることにある。
- 現段階では常駐 subagent は未導入で、このディレクトリはその下位の実行基盤として維持されている。

## 関連ファイル

- [`src/agent/minecraft/brain-manager.ts`](/home/ojii3/src/github.com/ojii3/vicissitude/src/agent/minecraft/brain-manager.ts)
- [`src/mcp/minecraft/server.ts`](/home/ojii3/src/github.com/ojii3/vicissitude/src/mcp/minecraft/server.ts)
- [`src/mcp/minecraft/mcp-tools.ts`](/home/ojii3/src/github.com/ojii3/vicissitude/src/mcp/minecraft/mcp-tools.ts)
- [`src/mcp/minecraft/job-manager.ts`](/home/ojii3/src/github.com/ojii3/vicissitude/src/mcp/minecraft/job-manager.ts)
- [`src/mcp/minecraft/brain-wake.ts`](/home/ojii3/src/github.com/ojii3/vicissitude/src/mcp/minecraft/brain-wake.ts)
