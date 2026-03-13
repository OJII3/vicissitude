## MCP ツール一覧

### discord サーバー

- `send_typing(channel_id)` - タイピングインジケーター送信（8秒間隔で自動リピート、send_message/reply で自動停止、60秒タイムアウト）
- `send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）
- `reply(channel_id, message_id, content, file_path?)` - メッセージに返信（オプションでファイル添付）
- `add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `list_channels(guild_id)` - サーバーのテキストチャンネル一覧

### code-exec サーバー

- `execute_code(language, code)` - サンドボックスコンテナ内でコード実行
  - language: "javascript" | "typescript" | "python" | "shell"
  - コード長上限: 10,000 文字
  - タイムアウト: 15秒（コンテナ起動含む）
  - ネットワークアクセス不可、ファイルシステム読み取り専用（/tmp のみ書き込み可、10MB 上限）

### schedule サーバー

- `get_heartbeat_config` - 現在の heartbeat 設定を表示
- `list_reminders` - リマインダー一覧
- `add_reminder(id, description, schedule_type, interval_minutes?, daily_hour?, daily_minute?)` - リマインダー追加
- `update_reminder(id, description?, enabled?, schedule_type?, interval_minutes?, daily_hour?, daily_minute?)` - リマインダー更新
- `remove_reminder(id)` - リマインダー削除
- `set_base_interval(minutes)` - ベースチェック間隔を変更

### memory サーバー

- `read_memory` - MEMORY.md を読み取る
- `update_memory(content)` - MEMORY.md を上書き更新する（.bak バックアップ作成、空文字禁止、50,000 文字上限）
  - **MEMORY.md に記録する情報**:
    - サーバー・チャンネル情報（guild_id、チャンネル用途）
    - 行動ルール（メッセージ送信ルール、反応頻度、禁止事項）
    - 週次目標
    - 自己情報（使用モデルなど）
    - 時間に敏感な予定・制約（今週の会議予定など、不要になったら削除）
  - **MEMORY.md に記録しない情報**（LTM ファクトに自動蓄積される）:
    - ユーザーの背景・経歴・プロジェクト参加情報
    - ユーザーの性格・好み・関係性
    - 過去の出来事の詳細（日次ログや LTM エピソードに記録済み）
    - 関連プロジェクトの説明
- `read_soul` - SOUL.md を読み取る
- `append_daily_log(entry, date?)` - memory/YYYY-MM-DD.md に追記する（heartbeat 実行記録・自省メモ専用。会話まとめは LTM に自動記録されるため不要。追記のみ、過去7日以内、1日 20,000 文字上限）
- `read_daily_log(date?)` - 日次ログを読み取る（デフォルト: 今日）
- `list_daily_logs(limit?)` - 日次ログ一覧を表示する（デフォルト: 7件）
- `read_lessons` - LESSONS.md を読み取る
- `update_lessons(content)` - LESSONS.md を上書き更新する（更新前に `ltm_get_facts(category: "guideline")` で LTM guideline を確認し重複を避ける。.bak バックアップ作成、空文字禁止、30,000 文字上限）
- `cleanup_old_logs` - 7日より古い日次ログを削除する

### ltm サーバー（長期記憶）

fenghuang ベースの認知記憶システム。会話をエピソードに自動分割し、意味記憶（ファクト）に統合する。

> 会話メッセージの記録（ingestion）は自動化されています。
> Discord の全メッセージ（bot 自身の発言を含む）は自動的に LTM に取り込まれます。

- `ltm_retrieve(guild_id, query, limit?)` - 関連する長期記憶をハイブリッド検索で取得
  - テキスト検索＋ベクトル検索＋忘却曲線によるリランキング
  - エピソード記憶（過去の会話まとめ）と意味記憶（蓄積ファクト）の両方を返す
  - **使いどき**: ユーザーへの返信を作成する前に、関連する過去の記憶を想起したいとき
- `ltm_consolidate(guild_id)` - 未統合エピソードからファクト（意味記憶）を抽出・統合
  - エピソードを分析し、ユーザーに関する永続的な事実（好み、性格、関係性など）を抽出
  - 既存ファクトの強化・更新・無効化も自動判定
  - **使いどき**: 定期的に（heartbeat リマインダーなどで）実行し、記憶を整理する
- `ltm_get_facts(guild_id, category?)` - 蓄積されたファクト一覧を取得
  - category: "identity" | "preference" | "interest" | "personality" | "relationship" | "experience" | "goal" | "guideline"
  - **使いどき**: 特定カテゴリのファクトを確認したいとき

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
  - **ジョブシステム**: `follow_player` / `go_to` / `collect_block` / `craft_item` / `sleep_in_bed` は非同期ジョブとして実行され、即座に jobId を返す。ジョブは1つのみ同時実行可能で、新ジョブ開始時に既存ジョブは自動キャンセルされる。`observe_state` の行動欄や `get_job_status` でジョブの進捗を確認できる。
- `get_viewer_url` - Minecraft ビューアーの URL を返す
  - prismarine-viewer ベースの Web ビューアー（ブラウザで 3D ワールドをリアルタイム表示）
  - ボット未接続時はエラーメッセージを返す
  - デフォルトポート: 3007（`MC_VIEWER_PORT` 環境変数で変更可能）

### マイクラ操作ツール（マイクラ接続中に機能）

自分の Minecraft での行動を管理するツール。

- `minecraft_delegate(command)` - マイクラの自分に指示を出す（次のポーリングで反映される）
  - **使いどき**: ユーザーから「ダイヤ探して」「拠点を作って」など Minecraft 内での作業指示があったとき
  - command: 自然言語での指示内容（最大 10,000 文字）
- `minecraft_status` - マイクラでの最近の出来事を確認する（消費しない）
  - **使いどき**: Minecraft の現在の状況を確認したいとき（`<minecraft-status>` セクションの情報が古い場合）
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

### 組み込みツール（OpenCode SDK）

- `webfetch(url)` - 指定 URL の内容を取得して返す
- `websearch(query)` - Web 検索を実行して結果を返す
