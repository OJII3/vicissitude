# STATUS.md

## 1. 最終更新

- 2026-03-01
- 更新者: AI
- ブランチ: feat/memory-mcp-server

## 2. 現在の真実（Project Truth）

- Clean Architecture への移行が完了し、main にマージ済み。
- domain / application / infrastructure の 3 層構成で、依存方向ルールは正しく守られている。
- DI は手動コンストラクタ注入（Pure DI）で `composition-root.ts` に集約している。
- テストは `bun test` で実行可能（38件: splitMessage 6件 + HandleIncomingMessageUseCase 5件 + CooldownTracker 5件 + HandleHomeChannelMessageUseCase 6件 + heartbeat-evaluator 9件 + HandleHeartbeatUseCase 5件 + oxlintrc override 2件）。
- Bot メンションまたはスレッド内メッセージに AI が必ず応答する。
- **ホームチャンネルでは AI が自律的に respond/react/ignore を判断して参加する（新機能）。**
- AI 推論は OpenCode SDK 経由で `github-copilot:claude-sonnet-4.6` を使用する。
- セッションは `data/sessions.json` に JSON で永続化している。
  - メンション/スレッド: ユーザー単位セッション (`platform:channelId:authorId`)
  - ホームチャンネル: チャンネル単位共有セッション (`platform:channelId:_channel`)
- ブートストラップコンテキストは `context/` 配下の Markdown から読込む。
- チャンネル設定は `context/channels.json` で管理する。
- MCP サーバーは `discord-server.ts`（Discord 操作）、`code-exec-server.ts`（コード実行）、`schedule-server.ts`（Heartbeat スケジュール管理）、`memory-server.ts`（メモリ・人格管理）の 4 つ。
- **Heartbeat 自律行動システム: 1分間隔チェックループで due なリマインダーを検知し、AI セッションを起動して自律行動する。**
- **memory MCP サーバーで MEMORY.md / SOUL.md / LESSONS.md / 日次ログの構造化された読み書きが可能。**
- `nr validate` (fmt:check + lint + check) および `bun test` が通る。
- Graceful shutdown（SIGINT/SIGTERM）実装済み。
- エラー時はユーザーに汎用メッセージを返し、詳細はログのみに記録する。
- ペルソナ（SOUL.md）を全面刷新。Anti-AI-Slop ルール、会話参加判断基準、感情表現パターンを追加。

## 3. 確定済み方針

1. 人格名は「ふあ」。
2. TypeScript + Bun ランタイム。
3. Clean Architecture + Ports and Adapters。
4. Pure DI（DI コンテナなし）。
5. MCP サーバーは独立プロセスとしてレイヤー外に配置。
6. `STATUS.md` は作業ごとに更新する。
7. ホームチャンネルでは AI が自律的に参加判断する（do_nothing を選べる bot）。
8. クールダウンで不要な AI 呼び出しを抑制する。
9. Heartbeat システムで定期的な自律行動を実行する（interval / daily スケジュール対応）。
10. スケジュール管理は MCP ツール経由で通常会話からも変更可能。
11. メモリ管理は専用 MCP サーバー経由で行い、安全策（バックアップ、サイズ上限、append-only）を適用。

## 4. 既知のバグ・要修正事項

前回の 11 件は全て修正済み。新規の問題はなし。

## 5. 直近タスク

1. `context/channels.json` にホームチャンネル ID を設定して動作確認する
2. テスト用 Discord サーバーでの E2E 検証
3. judge プロンプトのチューニング（実際の会話で検証・調整）
4. infrastructure 層のテストカバレッジ拡充
5. code-exec のコンテナ化によるサンドボックス実装

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. code-exec のサンドボックス欠如による RCE リスク（説明文は修正済み、環境変数は制限済み、コンテナ化は未対応）。
2. judge の AI 呼び出しコスト（クールダウンで緩和済み、将来的に軽量モデル切り替えも検討）。
3. judge のレスポンスパース失敗時は ignore にフォールバック（安全側）。

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
