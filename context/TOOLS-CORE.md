## MCP ツール一覧（コア）

### discord サーバー

> `channel_id` にはテキストチャンネルだけでなくスレッド・フォーラムスレッドの ID も指定可能。

- `send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）
- `reply(channel_id, message_id, content, file_path?)` - メッセージに返信（オプションでファイル添付）
- `add_reaction(channel_id, message_id, emoji)` - リアクション追加
- `read_messages(channel_id, limit?)` - チャンネルの最近のメッセージを読む
- `list_channels` - サーバーのテキストチャンネル一覧

### schedule サーバー

- `get_heartbeat_config` - 現在の heartbeat 設定を表示
- `list_reminders` - リマインダー一覧（現在のギルド＋グローバルのみ表示）
- `add_reminder(id, description, schedule_type, interval_minutes?, daily_hour?, daily_minute?, global?)` - リマインダー追加（デフォルトで現在のギルドに紐づく。`global: true` でギルド横断リマインダー）
- `update_reminder(id, description?, enabled?, schedule_type?, interval_minutes?, daily_hour?, daily_minute?)` - リマインダー更新（自ギルドまたはグローバルのみ）
- `remove_reminder(id)` - リマインダー削除（自ギルドまたはグローバルのみ）
- `set_base_interval(minutes)` - ベースチェック間隔を変更

### memory サーバー（長期記憶）

Discord の全メッセージは自動的に記憶に取り込まれる（ingestion は自動）。

- `memory_retrieve(query, limit?)` - 関連する長期記憶を検索して取得
- `memory_get_facts(category?)` - 蓄積されたファクト一覧を取得
  - category: "identity" | "preference" | "interest" | "personality" | "relationship" | "experience" | "goal" | "guideline"

### spotify サーバー

> `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` が設定されている場合のみ有効。

- `spotify_pick_track` - Spotify ライブラリからランダムに1曲選んで情報を返す。引数なし
- `spotify_search(query, limit?)` - 曲名・アーティスト名などのキーワードで Spotify を検索
- `spotify_saved_tracks(limit?, offset?)` - お気に入りの曲（Liked Songs）を取得
- `spotify_track_detail(trackId)` - トラック ID から楽曲の詳細情報を取得（アーティストのジャンル情報補完付き）

### genius サーバー

> `GENIUS_ACCESS_TOKEN` が設定されている場合のみ有効。

- `fetch_lyrics(title, artist)` - Genius API から楽曲の歌詞を取得
- `save_listening_fact(track, impression)` - 楽曲を聴いた感想を Memory（internal namespace, category=experience）に保存

### メタ

- `list_tools` - 利用可能なツールの名前と説明の一覧を取得

### 組み込みツール（OpenCode SDK）

- `webfetch(url)` - 指定 URL の内容を取得して返す
