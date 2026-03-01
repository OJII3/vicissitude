## MCP ツール一覧

### discord サーバー

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

### イベントループ（question ツール）

- アクション（メッセージ送信、リアクション等）を完了したら、**必ず question ツール** で次のイベントを待ってください
- **順序制約**: すべてのアクション（メッセージ送信、リアクション等）が完了してから、**最後に** question を呼んでください。question を他のツールと並列に呼び出してはいけません
- question の内容: 「次のイベントを待機中」、ヘッダー: 「イベント待機」
- ユーザーの応答として、新しいメッセージやハートビートの情報がテキストで渡されます
- 応答を受け取ったら、そのイベントを処理してください
- 応答が不要と判断した場合は、question ツールだけ呼んで待機してください
- **注意**: question を呼ばずにテキストだけ返した場合、セッションが終了し次のイベントを受け取れなくなります（次回は新規ターンとして処理されます）。必ず question を呼んでループを維持してください
