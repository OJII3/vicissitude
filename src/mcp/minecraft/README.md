# Minecraft MCP サーバー + Minecraft エージェント計画

## 現在の構成

Minecraft MCP サーバーは mineflayer ベースの独立プロセスとして動作し、StreamableHTTP で MCP ツールを提供する。

### ファイル構成

```
src/mcp/minecraft/
├── server.ts              # エントリポイント（HTTP MCP サーバー起動 + mineflayer 接続）
├── http-server.ts         # StreamableHTTP トランスポート
├── mcp-tools.ts           # MCP ツール登録（observe/action 統合）
├── bot-connection.ts      # mineflayer 接続管理
├── bot-context.ts         # BotContext（イベントバッファ + アクションステート）
├── bot-queries.ts         # ボット状態クエリ（インベントリ、周辺、天気等）
├── state-summary.ts       # 状態要約テキスト生成
├── job-manager.ts         # バックグラウンドジョブ管理
├── helpers.ts             # 共通ヘルパー（フォーマッタ、型定義）
└── actions/
    ├── movement.ts        # follow_player, go_to, collect_block, stop
    ├── interaction.ts     # send_chat, equip_item, place_block
    ├── jobs.ts            # craft_item, sleep_in_bed（ジョブ登録）
    ├── survival/
    │   ├── food.ts        # eat_food + 食料優先度判定
    │   ├── escape.ts      # flee_from_entity
    │   ├── shelter.ts     # find_shelter + 緊急シェルター構築
    │   └── index.ts       # サバイバル系ツールの集約
    └── shared.ts          # 共通ヘルパー（collectBedIds, ensureMovements 等）
```

### 提供ツール

| ツール              | 種別 | 説明                                      |
| ------------------- | ---- | ----------------------------------------- |
| `observe_state`     | 観察 | 現在状態の自然言語要約                    |
| `get_recent_events` | 観察 | 直近イベント取得（importance フィルタ可） |
| `get_job_status`    | 観察 | 現在・履歴ジョブ                          |
| `get_viewer_url`    | 観察 | prismarine-viewer URL                     |
| `follow_player`     | 行動 | プレイヤー追従                            |
| `go_to`             | 行動 | 座標移動                                  |
| `collect_block`     | 行動 | ブロック採集                              |
| `stop`              | 行動 | 移動/追従停止                             |
| `craft_item`        | 行動 | クラフト（ジョブ）                        |
| `sleep_in_bed`      | 行動 | 就寝試行（ジョブ）                        |
| `equip_item`        | 行動 | アイテム装備                              |
| `place_block`       | 行動 | ブロック設置                              |
| `send_chat`         | 行動 | ゲーム内チャット送信                      |
| `eat_food`          | 行動 | インベントリから食料を選んで食べる        |
| `flee_from_entity`  | 行動 | 指定エンティティから逃走（非同期ジョブ）  |
| `find_shelter`      | 行動 | 安全な避難場所を探して移動                |

### 環境変数

- `MC_HOST`: Minecraft サーバーホスト（必須）
- `MC_PORT`: ポート（デフォルト: `25565`）
- `MC_USERNAME`: bot ユーザー名（デフォルト: `hua`）
- `MC_VERSION`: バージョン指定（省略可）
- `MC_MCP_PORT`: MCP HTTP ポート（デフォルト: `3001`）

### 設計上の特徴

- **イベントバッファ**: BotContext 内に最大 100 件のイベントを保持（importance: low/medium/high）
- **ジョブシステム**: 長時間アクション（クラフト、睡眠等）を非同期ジョブとして管理。1 つだけ同時実行、新規開始時に既存を自動キャンセル
- **状態要約**: 生データを LLM に渡さず、summarizeState() で自然言語に変換してからツール応答に使用

---

## Minecraft エージェント計画（M12）

### 動機

現状は Discord 側（会話エージェント）が Minecraft ツールを直接使うが、以下の問題がある:

1. **リソース競合** — Minecraft 常時監視が Discord 側の応答を圧迫する
2. **反応性の欠如** — ポーリング間隔に依存し、敵接近等の即時対応が困難
3. **記憶の断裂** — Guild ごとの記憶分離により、Minecraft 世界の連続性が失われる
4. **自律感の不足** — ユーザーが話しかけないと何もしない

### アーキテクチャ

```
┌─────────────────────────────┐
│       Discord Agent          │
│    (conversation agent)     │
│                             │
│  minecraft_delegate()       │
│  minecraft_status()         │
│  minecraft_read_reports()   │
└──────────┬──────────────────┘
           │ Event Bridge (SQLite)
           │ mc_bridge_events テーブル
┌──────────▼──────────────────┐
│    Minecraft Agent          │
│    (minecraft agent profile)│
│                             │
│  独自 AgentRunner           │
│  独自ポーリングループ         │
│  Minecraft グローバル記憶    │
│                             │
│  ┌────────┐ ┌─────┐ ┌────┐ │
│  │Reactive│ │Goal │ │Skill│ │
│  │Layer   │ │Plan │ │Mem │ │
│  └────────┘ └─────┘ └────┘ │
└──────────┬──────────────────┘
           │ MCP (remote)
┌──────────▼──────────────────┐
│   Minecraft MCP Server      │
│   (このディレクトリ)         │
└─────────────────────────────┘
```

### Minecraft エージェントの責務

#### Reactive Layer — 生存本能

- 敵 mob 接近時の回避行動
- 夜間の自動就寝
- 体力・空腹が低い時の対応（食事、退避）
- 危険イベントの Discord 側への即時報告

#### Goal Planner — 自動カリキュラム

- 現在の装備・進捗から次の達成目標を自動発見（tech tree ベース）
- 目標に向けたサブゴール分解と段階的実行
- 達成時の記録と Discord 側への報告

#### Skill Memory — 学習記録

- 成功した行動パターンの自然言語記録
- 例: 「鉄鉱石は Y=16 以下で多い」「クリーパーは距離を取る」
- 記録はファイルベース（`data/context/minecraft/MINECRAFT-SKILLS.md`）

### Discord 側との通信

Event Bridge（`store/mc-bridge.ts`）を介した非同期メッセージング:

| 方向         | ツール                           | 用途                               |
| ------------ | -------------------------------- | ---------------------------------- |
| Discord → MC | `minecraft_delegate(command)`    | 高レベル指示（「ダイヤ探して」等） |
| Discord → MC | `minecraft_start_session()`      | Minecraft エージェント起動         |
| Discord → MC | `minecraft_stop_session()`       | Minecraft エージェント停止         |
| MC → Discord | `mc_report(message, importance)` | 状況報告（発見、達成、危険等）     |
| Discord ← MC | `minecraft_status()`             | 現在状態の要約取得                 |
| Discord ← MC | `minecraft_read_reports()`       | 未読レポート取得                   |

### Minecraft グローバル記憶

Guild に依存しない、Minecraft 専用の記憶空間:

```
context/minecraft/              # git 管理（ベース）
├── MINECRAFT-IDENTITY.md       # Minecraft エージェントの行動指針
├── MINECRAFT-KNOWLEDGE.md      # Minecraft 基礎知識
├── MINECRAFT-GOALS.md          # 目標管理テンプレート
└── MINECRAFT-SKILLS.md         # スキルライブラリテンプレート

data/context/minecraft/          # オーバーレイ（ランタイム書き込み先）
├── MINECRAFT-GOALS.md           # 目標管理（現在・達成済み）
└── MINECRAFT-SKILLS.md          # 学習済みスキル・知識
```

### 実装フェーズ

| フェーズ | 概要                                               | 依存 |
| -------- | -------------------------------------------------- | ---- |
| **M12a** | 基盤: AgentProfile + Event Bridge + グローバル記憶 | なし |
| **M12b** | リアクティブ行動: 生存本能（逃走、就寝、食事）     | M12a |
| **M12c** | 目標管理: 自動カリキュラム + スキル記録            | M12a |
| **M12d** | Discord 側統合: delegate、状態注入、Discord 共有   | M12c |

M12b と M12c は並行着手可能。

### このディレクトリへの影響

Minecraft エージェントは既存の MCP ツールをリモートクライアントとして利用する。M12b で `actions/survival/`（`eat_food`, `flee_from_entity`, `find_shelter` の責務別分割）と `actions/shared.ts`（共通ヘルパー）を既存の `actions/` パターンに従って追加した。

### 先行研究

- [Voyager](https://voyager.minedojo.org/) — スキルライブラリ、自動カリキュラム、自己検証
- [GITM (Ghost in the Minecraft)](https://openreview.net/pdf?id=cTOL99p5HL) — 階層的プランニング、テキストベース記憶
- [Project Sid (PIANO)](https://arxiv.org/html/2411.00114v1) — マルチエージェント並行処理
- [Mindcraft](https://github.com/mindcraft-bots/mindcraft) — 認知機能ごとの LLM モジュール分離
