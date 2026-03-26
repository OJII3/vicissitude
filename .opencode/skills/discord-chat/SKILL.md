---
name: discord-chat
description: Discord のメッセージ送受信・リアクション・チャンネル操作。会話への参加、返信、リアクション追加、チャンネルの履歴確認に使う
---

## Discord 通信ツール（discord サーバー）

- `send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）
- `reply(channel_id, message_id, content, file_path?)` - メッセージに返信（オプションでファイル添付）
- `add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `list_channels` - サーバーのテキストチャンネル一覧
