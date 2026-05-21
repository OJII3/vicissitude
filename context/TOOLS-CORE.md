## MCP ツール一覧（コア）

> すべて `core_` プレフィックス付きで呼び出す（OpenCode が自動付与）。

### schedule

- `core_get_heartbeat_config` - 現在の heartbeat 設定を表示
- `core_list_reminders` - リマインダー一覧（現在の scope＋グローバルのみ表示）
- `core_add_reminder(id, description, schedule_type, interval_minutes?, daily_hour?, daily_minute?, global?)` - リマインダー追加（デフォルトで現在の scope に紐づく。`global: true` で scope 横断リマインダー）
- `core_update_reminder(id, description?, enabled?, schedule_type?, interval_minutes?, daily_hour?, daily_minute?)` - リマインダー更新（自 scope またはグローバルのみ）
- `core_remove_reminder(id)` - リマインダー削除（自 scope またはグローバルのみ）
- `core_set_base_interval(minutes)` - ベースチェック間隔を変更

### memory（長期記憶）

会話メッセージは platform adapter 経由で自動的に記憶に取り込まれる（ingestion は自動）。

- `core_memory_retrieve(query, limit?)` - 関連する長期記憶を検索して取得
- `core_memory_get_facts(category?)` - 蓄積されたファクト一覧を取得
  - category: "identity" | "preference" | "interest" | "personality" | "relationship" | "experience" | "goal" | "guideline"

### メタ

- `core_list_tools` - 利用可能なツールの名前と説明の一覧を取得

### 組み込みツール（OpenCode SDK）

- `webfetch(url)` - 指定 URL の内容を取得して返す
