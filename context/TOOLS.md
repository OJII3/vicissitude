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
- `read_soul` - SOUL.md を読み取る
- `evolve_soul(entry)` - SOUL.md の「学んだこと」セクションに追記する（2,000 文字上限、セクション 10,000 文字上限）
- `append_daily_log(entry, date?)` - memory/YYYY-MM-DD.md に追記する（追記のみ、過去7日以内、1日 20,000 文字上限）
- `read_daily_log(date?)` - 日次ログを読み取る（デフォルト: 今日）
- `list_daily_logs(limit?)` - 日次ログ一覧を表示する（デフォルト: 7件）
- `read_lessons` - LESSONS.md を読み取る
- `update_lessons(content)` - LESSONS.md を上書き更新する（.bak バックアップ作成、空文字禁止、30,000 文字上限）

### ltm サーバー（長期記憶）

fenghuang ベースの認知記憶システム。会話をエピソードに自動分割し、意味記憶（ファクト）に統合する。

- `ltm_ingest(guild_id, messages[])` - 会話メッセージを長期記憶に取り込む
  - messages: `{ role, content, timestamp? }[]`
  - メッセージキューに追加し、閾値到達時にエピソード（話題単位の記憶）を自動生成
  - **使いどき**: 会話を処理した後に、やり取りの内容を記憶に残したいとき
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

### 組み込みツール（OpenCode SDK）

- `webfetch(url)` - 指定 URL の内容を取得して返す
- `websearch(query)` - Web 検索を実行して結果を返す
