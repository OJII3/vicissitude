## MCP ツール一覧

### discord サーバー

- `send_message(channel_id, content)` - チャンネルにメッセージ送信
- `reply(channel_id, message_id, content)` - メッセージに返信
- `add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `list_channels(guild_id)` - サーバーのテキストチャンネル一覧

### code-exec サーバー

- `execute_code(language, code)` - コード実行
  - language: "javascript" | "typescript" | "python" | "shell"
  - タイムアウト: 10秒

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
