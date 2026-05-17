# Minecraft MCP サーバー

`packages/minecraft` は mineflayer ベースの Minecraft 操作用 MCP サーバーと、Minecraft agent 用の `mc-bridge` stdio サーバーを提供するパッケージである。
意思決定は行わず、状態観察・明示 action・Discord bridge との接続に責務を限定する。

## 現在の構成

```text
packages/minecraft/
├── src/
│   ├── server.ts              # Minecraft MCP HTTP entrypoint
│   ├── mc-bridge-server.ts    # Minecraft agent 用 mc-bridge stdio entrypoint
│   ├── http-server.ts         # @vicissitude/mcp/http-server の再 export
│   ├── mcp-tools.ts           # observe / recovery / action tool 登録
│   ├── bot-connection.ts      # mineflayer 接続管理
│   ├── bot-context.ts         # bot 参照、イベント、行動状態の context
│   ├── bot-queries.ts         # 観察用 query helper
│   ├── state-summary.ts       # 状態・イベント・ジョブ履歴の自然言語整形
│   ├── job-manager.ts         # 非同期ジョブ、履歴、クールダウン、stuck 判定
│   ├── stuck-recovery.ts      # respawn / stuck recovery action
│   ├── reactive-layer.ts      # 危険・死亡などの reactive safety layer
│   ├── auto-notifier.ts       # 重要イベントを bridge DB へ通知
│   ├── mc-metrics.ts          # Prometheus metrics
│   └── actions/              # Minecraft action tool 群
└── README.md
```

`server.ts` と `mc-bridge-server.ts` は `import.meta.main` guard 済みで、import だけではプロセスを起動しない。

## Minecraft MCP tools

| ツール              | 種別 | 説明                                                     |
| ------------------- | ---- | -------------------------------------------------------- |
| `observe_state`     | 観察 | 現在状態を自然言語要約で返す。復旧は実行せず提案のみ返す |
| `recover_state`     | 行動 | 死亡時の respawn、stuck 時の recovery を明示実行する     |
| `get_recent_events` | 観察 | 直近イベントを取得する。`importance` でフィルタ可能      |
| `get_job_status`    | 観察 | 実行中ジョブ、履歴、クールダウンを取得する               |
| `get_viewer_url`    | 観察 | prismarine-viewer の URL を返す                          |
| `nearby_blocks`     | 観察 | 周辺ブロックの種類と数を返す                             |
| `craftable_items`   | 観察 | 現在のインベントリでクラフト可能なアイテムを返す         |
| `get_biome`         | 観察 | 現在位置のバイオーム名を返す                             |
| `follow_player`     | 行動 | プレイヤー追従ジョブを開始する                           |
| `go_to`             | 行動 | 座標移動ジョブを開始する                                 |
| `collect_block`     | 行動 | ブロック採集ジョブを開始する                             |
| `stop`              | 行動 | 現在の移動・追従・ジョブを停止する                       |
| `send_chat`         | 行動 | ゲーム内チャットを送信する                               |
| `equip_item`        | 行動 | アイテムを装備する                                       |
| `place_block`       | 行動 | ブロックを設置する                                       |
| `craft_item`        | 行動 | クラフトジョブを開始する                                 |
| `smelt_item`        | 行動 | 精錬ジョブを開始する                                     |
| `sleep_in_bed`      | 行動 | 就寝ジョブを開始する                                     |
| `eat_food`          | 行動 | 手持ち食料から選んで食べる                               |
| `flee_from_entity`  | 行動 | 指定エンティティから逃走する                             |
| `find_shelter`      | 行動 | 近場の避難場所探索と退避を行う                           |
| `attack_entity`     | 行動 | 指定エンティティを攻撃する                               |
| `search_for_block`  | 行動 | 指定ブロックを段階的に探索する                           |
| `explore_direction` | 行動 | 指定方向に移動して新しいエリアを開拓する                 |

## 状態・復旧の境界

- `observe_state` は mineflayer の生オブジェクトを返さず、位置・体力・空腹・周辺エンティティ・装備・インベントリ・直近イベント・stuck 警告を要約する。
- `observe_state` は respawn / random walk / reconnect / session rotation を実行しない。死亡または stuck を検知した場合は `recover_state` の実行を提案する。
- `recover_state` は明示 action tool として、死亡時は `respawnWithRetry`、stuck 時は `attemptStuckRecovery` を実行する。
- `BotContext` と `JobManager` の getter は snapshot copy を返し、内部配列・現在ジョブ・履歴ジョブを外部から変更できないようにする。

## DB / session lock

- `DATA_DIR` が設定されている場合、`server.ts` は `@vicissitude/store` の SQLite DB を開き、bridge DB として使う。
- Minecraft bot 接続は session lock に連動する。`hasSessionLock(db)` が true になったとき接続し、lock が解放されたら切断する。
- session lock は 10 秒間隔で polling される。DB なしの開発環境では従来通り即時接続する。
- 重要イベントは `auto-notifier.ts` が bridge DB に書き込み、Discord 側 agent へ通知する。`DATA_DIR` 未設定時は自動通知を無効化する。
- `mc-bridge-server.ts` は `DATA_DIR`（未設定時は `APP_ROOT/data`）を使い、Discord 連携と Minecraft memory overlay を stdio MCP として提供する。

## mc-bridge tools

`mc-bridge-server.ts` は `@vicissitude/mcp` の bridge / memory tool を登録する。

| ツール               | 説明                                                    |
| -------------------- | ------------------------------------------------------- |
| `mc_report`          | Minecraft 側から Discord 側へレポートを送信する         |
| `check_commands`     | Discord 側から Minecraft agent 宛の指示を取得・消費する |
| `mc_read_goals`      | Minecraft 目標ファイルを読む                            |
| `mc_update_goals`    | Minecraft 目標ファイルを更新する                        |
| `mc_read_progress`   | Minecraft 進捗ファイルを読む                            |
| `mc_update_progress` | Minecraft 進捗ファイルを更新する                        |
| `mc_read_skills`     | Minecraft スキルライブラリを読む                        |
| `mc_record_skill`    | Minecraft スキルライブラリへスキルを追記する            |

## 環境変数

| 変数                 | 必須 | 既定値    | 説明                                                 |
| -------------------- | ---- | --------- | ---------------------------------------------------- |
| `MC_HOST`            | yes  | -         | Minecraft サーバーホスト                             |
| `MC_PORT`            | no   | `25565`   | Minecraft サーバーポート                             |
| `MC_USERNAME`        | no   | `hua`     | bot ユーザー名                                       |
| `MC_VERSION`         | no   | 自動      | mineflayer 接続バージョン                            |
| `MC_AUTH_MODE`       | no   | `offline` | `offline` または `microsoft`                         |
| `MC_PROFILES_FOLDER` | no   | -         | Microsoft auth profile 保存先                        |
| `MC_MCP_PORT`        | no   | `3001`    | Minecraft MCP HTTP ポート                            |
| `MC_VIEWER_PORT`     | no   | `3007`    | prismarine-viewer ポート                             |
| `MC_METRICS_PORT`    | no   | `9092`    | Prometheus metrics ポート                            |
| `MC_METRICS_HOST`    | no   | `0.0.0.0` | metrics bind host                                    |
| `DATA_DIR`           | no   | -         | bridge DB / session lock / memory overlay の保存先   |
| `APP_ROOT`           | no   | cwd       | `mc-bridge-server.ts` の `DATA_DIR` 既定値算出に使う |

## 関連ファイル

- `packages/minecraft/src/server.ts`
- `packages/minecraft/src/mc-bridge-server.ts`
- `packages/minecraft/src/mcp-tools.ts`
- `packages/minecraft/src/job-manager.ts`
- `packages/minecraft/src/stuck-recovery.ts`
- `packages/minecraft/src/auto-notifier.ts`
- `packages/agent/src/mcp-config.ts`
