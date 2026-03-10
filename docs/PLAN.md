# PLAN.md

## 1. 方針

- OpenCode SDK を AI ランタイムとして使用。責務別フラットモジュール構成（Pure DI）。
- 永続化は SQLite（Drizzle ORM）に統一。MCP サーバーは 4 プロセス構成。
- 詳細なアーキテクチャは `ARCHITECTURE.md` を参照。
- 完了済みマイルストーン（M1-M12d）の記録は `CHANGELOG.md` を参照。

## 2. 完了定義（DoD）

- `nr validate` が通る
- `bun test` が通る
- ドキュメント（ARCHITECTURE.md, STATUS.md）が現在の実装と一致する
- 手動動作確認: Discord 応答、Heartbeat 自律行動、Minecraft 接続（MC_HOST 設定時）
- 旧ディレクトリ・旧ファイルが `src/` に残っていない
- PR は各マイルストーン単位でマージする

## 3. 次のマイルストーン

現在、未着手の計画マイルストーンはなし。運用観察フェーズ。
