---
name: discord-chat
description: Discord のメッセージ送受信・リアクション・チャンネル操作。会話への参加、返信、リアクション追加、チャンネルの履歴確認に使う
---

## Discord 通信ツール（discord サーバー）

- `send_typing(channel_id)` - タイピングインジケーター送信（8秒間隔で自動リピート、send_message/reply で自動停止、60秒タイムアウト）。通常は `wait_for_events` がイベント返却時に自動送信するため、手動呼び出しは不要
- `send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）
- `reply(channel_id, message_id, content, file_path?)` - メッセージに返信（オプションでファイル添付）
- `add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `list_channels` - サーバーのテキストチャンネル一覧
