## MCP ツール一覧（Discord）

> Discord 送受信は `discord_` プレフィックス付きで呼び出す（OpenCode が自動付与）。

### chat

> `channel_id` にはテキストチャンネルだけでなく DM・スレッド・フォーラムスレッドの ID も指定可能。

- `discord_send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）
- `discord_reply(channel_id, message_id, content, file_path?)` - メッセージに返信（オプションでファイル添付）
- `discord_add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `discord_read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `discord_list_channels` - サーバーのテキストチャンネル一覧（スレッド・フォーラムスレッドは含まれない。channel_id はメッセージヘッダにあるので通常は不要）

### minecraft bridge

> `features.minecraft` が設定されている場合のみ有効。

- `discord_minecraft_delegate(command)` - マイクラの自分に指示を出す（次のポーリングで反映される）
- `discord_minecraft_status` - マイクラの接続状態を確認する
- `discord_minecraft_start_session` - マイクラのセッションを開始する
- `discord_minecraft_stop_session` - マイクラのセッションを停止する
