---
name: discord-schedule
description: リマインダーの追加・更新・削除と heartbeat 設定の管理。自律行動のスケジュールを変更したいときに使う
---

## スケジュール管理ツール（schedule サーバー）

- `get_heartbeat_config` - 現在の heartbeat 設定を表示
- `list_reminders` - リマインダー一覧（現在のギルド＋グローバルのみ表示）
- `add_reminder(id, description, schedule_type, interval_minutes?, daily_hour?, daily_minute?, global?)` - リマインダー追加（デフォルトで現在のギルドに紐づく。`global: true` でギルド横断リマインダー）
- `update_reminder(id, description?, enabled?, schedule_type?, interval_minutes?, daily_hour?, daily_minute?)` - リマインダー更新（自ギルドまたはグローバルのみ）
- `remove_reminder(id)` - リマインダー削除（自ギルドまたはグローバルのみ）
- `set_base_interval(minutes)` - ベースチェック間隔を変更
