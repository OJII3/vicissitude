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
