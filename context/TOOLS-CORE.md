## MCP ツール一覧（コア）

### discord サーバー

- `send_message(channel_id, content, file_path?)` - チャンネルにメッセージ送信（オプションでファイル添付）。スレッド・フォーラムスレッドにも送信可能
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

fenghuang ベースの認知記憶システム。会話をエピソードに自動分割し、意味記憶（ファクト）に統合する。

> 会話メッセージの記録（ingestion）は自動化されています。
> Discord の全メッセージ（bot 自身の発言を含む）は自動的に記憶に取り込まれます。

- `memory_retrieve(query, limit?)` - 関連する長期記憶をハイブリッド検索で取得
  - テキスト検索＋ベクトル検索＋忘却曲線によるリランキング
  - エピソード記憶（過去の会話まとめ）と意味記憶（蓄積ファクト）の両方を返す
  - **使いどき**: ユーザーへの返信を作成する前に、関連する過去の記憶を想起したいとき
- `memory_get_facts(category?)` - 蓄積されたファクト一覧を取得
  - category: "identity" | "preference" | "interest" | "personality" | "relationship" | "experience" | "goal" | "guideline"
  - **使いどき**: 特定カテゴリのファクトを確認したいとき

### spotify サーバー

> `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` が設定されている場合のみ有効。

- `spotify_pick_track` - Spotify ライブラリ（Saved Tracks, Recently Played, おすすめプレイリスト）から1曲ランダムに選んで情報を返す。人気度で重み付けされた選曲。引数なし
  - 返却 JSON: `{ id, name, artistName, albumName, genres, popularity, releaseDate, albumArtUrl, spotifyUrl }`
  - オプション env: `SPOTIFY_RECOMMEND_PLAYLIST_ID` — 指定するとプレイリストのトラックも候補に含まれる
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
