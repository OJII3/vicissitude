## MCP ツール一覧（Minecraft）

### mc-memory（Minecraft 記憶管理）

- `mc_read_goals` - 現在の Minecraft 目標を読む
- `mc_update_goals(content)` - 目標ファイルを上書き更新する（バックアップ自動作成）
- `mc_read_progress` - ワールド進捗を読む（装備段階、拠点、探索範囲、主要資源、達成済み目標）
- `mc_update_progress(content)` - ワールド進捗を更新する（バックアップ自動作成）
- `mc_read_skills` - スキルライブラリを読む
- `mc_record_skill(name, description, preconditions?, failure_patterns?)` - スキルを追記する

### minecraft サーバー（MC_HOST 設定時のみ有効）

Minecraft ワールドに接続中のボットを操作する。

- `observe_state` - ボットの現在の状態を**自然言語要約テキスト**で取得する
  - 状態: 位置、体力（♥バー）、空腹度、時間帯、天候、現在の行動
  - 周辺: 近くのエンティティ（hostile mob は ⚠ 付き、上位5件）
  - インベントリ: アイテム名×個数を1行で列挙、空スロット数
  - 装備: 装着中のもの
  - 直近イベント: 重要度 medium 以上のみ表示（最新10件から抽出）
- `get_recent_events(limit?, importance?)` - 直近のイベントログをテキスト形式で取得する
  - limit: 取得件数（デフォルト: 10、最大: 50）
  - importance: 最低重要度フィルタ（"low" | "medium" | "high"、省略時は全件）
  - 種類: spawn, death, health, chat, kicked, damage, disconnect, playerJoined, playerLeft, timeChange, weatherChange, job
  - 各イベントには重要度（low/medium/high）が付与される
- `follow_player(username, range?)` - 指定プレイヤーへの追従を開始する（非同期ジョブ: 即座に jobId を返す、range デフォルト: 3）
- `go_to(x, y, z, range?)` - 指定座標への移動を開始する（非同期ジョブ: 即座に jobId を返す、range デフォルト: 2）
- `collect_block(blockName, count?, maxDistance?)` - 指定ブロックの採集を開始する（非同期ジョブ: 即座に jobId を返す、進捗更新あり、maxDistance デフォルト: 32）
- `send_chat(message)` - Minecraft ゲーム内チャットにメッセージを送信する（最大 256 文字、"/" 始まりのコマンド送信不可）
- `equip_item(itemName, destination?)` - インベントリのアイテムを装備する
  - destination: "hand" | "head" | "torso" | "legs" | "feet" | "off-hand"（デフォルト: hand）
- `place_block(blockName, x, y, z)` - 指定座標にブロックを設置する（隣接固体ブロックを自動検出、インベントリから自動装備）
- `craft_item(itemName, count?)` - 指定アイテムをクラフトする（非同期ジョブ: 即座に jobId を返す、作業台が必要な場合は 32 ブロック以内を自動検索して移動）
  - count: クラフト個数（デフォルト: 1、最大: 64）
- `sleep_in_bed(maxDistance?)` - 近くのベッドで就寝を試みる（非同期ジョブ: 即座に jobId を返す、全 16 色のベッド対応）
  - maxDistance: ベッド検索範囲（デフォルト: 32、最大: 64）
- `stop` - 現在のジョブ（移動・追従・採集・クラフト・就寝）を停止する
- `get_job_status(limit?)` - 現在のジョブ状態と直近のジョブ履歴を取得する
  - limit: 取得するジョブ履歴数（デフォルト: 5、最大: 20）
  - **ジョブシステム**: `follow_player` / `go_to` / `collect_block` / `craft_item` / `sleep_in_bed` / `attack_entity` / `eat_food` / `flee_from_entity` / `find_shelter` は非同期ジョブとして実行され、即座に jobId を返す。ジョブは1つのみ同時実行可能で、新ジョブ開始時に既存ジョブは自動キャンセルされる。`observe_state` の行動欄や `get_job_status` でジョブの進捗を確認できる。
- `get_viewer_url` - Minecraft ビューアーの URL を返す
  - prismarine-viewer ベースの Web ビューアー（ブラウザで 3D ワールドをリアルタイム表示）
  - ボット未接続時はエラーメッセージを返す
  - デフォルトポート: 3007（`MC_VIEWER_PORT` 環境変数で変更可能）

### 戦闘・サバイバル

- `attack_entity(entityName, count?)` - 指定エンティティを攻撃する（非同期ジョブ: 即座に jobId を返す）
- `eat_food(emergency?)` - 食料を食べる（非同期ジョブ: 即座に jobId を返す）
  - emergency: true の場合 golden_apple も使用する
- `flee_from_entity(entityName, distance?)` - 指定エンティティから逃走する（非同期ジョブ: 即座に jobId を返す）
- `find_shelter` - 近くの安全な場所を探す（非同期ジョブ: 即座に jobId を返す）

### マイクラ操作ツール（マイクラ接続中に機能）

自分の Minecraft での行動を管理するツール。

- `minecraft_delegate(command)` - マイクラの自分に指示を出す（次のポーリングで反映される）
  - **使いどき**: ユーザーから「ダイヤ探して」「拠点を作って」など Minecraft 内での作業指示があったとき
  - command: 自然言語での指示内容（最大 10,000 文字）
  - **依頼の出し方**: 曖昧な丸投げは避け、目的と成功条件を明確にする。例:「ダイヤ5個集めて」「拠点の周りを整地して」
- `minecraft_status` - マイクラの最新状況を構造化して確認する（消費しない）
  - **使いどき**: Minecraft の現在の状況を確認したいとき（`<minecraft-status>` セクションの情報が古い場合）
  - 出力: 危険/緊急 → 行き詰まり → 直近の出来事の順で表示
- `minecraft_read_reports` - マイクラでの出来事を確認済みにして読む
  - **使いどき**: 確認済みとしてクリアしたいとき
- `minecraft_start_session` - マイクラのセッションを開始する
  - **使いどき**: マイクラが停止中で、再開したいとき
- `minecraft_stop_session` - マイクラのセッションを停止する
  - **使いどき**: マイクラでの活動を一時中断したいとき

#### 使い方ガイドライン

1. ユーザーが Minecraft の状況を聞いたら → まず `<minecraft-status>` セクションを確認し、必要なら `minecraft_status` で最新情報を取得
2. ユーザーが Minecraft 内での作業を依頼したら → `minecraft_delegate` で自分のマイクラ側に指示を出す
3. 面白いこと・やばいことがあったら → Discord で自然に共有
4. セッション管理は通常不要（自動起動済み）。ユーザーから明示的に要求された場合のみ使用
5. 行き詰まり (stuck) レポートを見たら → 代替案を指示するか、ユーザーに判断を仰ぐ
6. danger レポートを見たら → ユーザーに状況を伝える（自動通知と重複しないよう確認）
