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
