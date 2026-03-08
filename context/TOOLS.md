## MCP ツール一覧

### discord サーバー

- `send_typing(channel_id)` - タイピングインジケーター送信（8秒間隔で自動リピート、send_message/reply で自動停止、60秒タイムアウト）
- `send_message(channel_id, content)` - チャンネルにメッセージ送信
- `reply(channel_id, message_id, content)` - メッセージに返信
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
  - 種類: spawn, death, health, chat, kicked, damage, disconnect, playerJoined, playerLeft, timeChange, weatherChange, follow, navigation, collect, stop
  - 各イベントには重要度（low/medium/high）が付与される
- `follow_player(username, range?)` - 指定プレイヤーへの追従を開始する
- `go_to(x, y, z, range?)` - 指定座標への移動を実行する
- `collect_block(blockName, count?, maxDistance?)` - 指定ブロックを探して採集する
- `stop` - 現在の移動・追従を停止する

### 組み込みツール（OpenCode SDK）

- `webfetch(url)` - 指定 URL の内容を取得して返す
- `websearch(query)` - Web 検索を実行して結果を返す
