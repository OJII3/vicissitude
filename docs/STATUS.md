# STATUS.md

## 1. 最終更新

- 2026-03-02
- 更新者: AI
- ブランチ: fix/event-loop-hotfix

## 2. 現在の真実（Project Truth）

- Clean Architecture への移行が完了し、main にマージ済み。
- domain / application / infrastructure の 3 層構成で、依存方向ルールは正しく守られている。
- DI は手動コンストラクタ注入（Pure DI）で `composition-root.ts` に集約している。
- テストは `bun test` で実行可能（94件）。
- Bot メンションまたはスレッド内メッセージに AI が必ず応答する。
- **ホームチャンネルでは AI が自律的に respond/react/ignore を判断して参加する。**
- **ホームチャンネルの react でギルドカスタム絵文字が使用可能（EmojiProvider 経由）。**
- **カスタム絵文字使用頻度トラッキング: `messageCreate`/`messageReactionAdd` からカウントを蓄積し、人気順トップ 20 のみを judge に渡すことでトークンコストを削減。**
- AI 推論は OpenCode SDK 経由。デフォルトは `opencode:big-pickle`（opencode zen 無料モデル）。環境変数 `OPENCODE_PROVIDER_ID` / `OPENCODE_MODEL_ID` で変更可能。
- **プロバイダ別イベント処理戦略を実装済み:**
  - **デフォルト（非 Copilot）**: `OpencodeAgent` が同期 `prompt()` で応答。judge + batching + cooldown の従来フロー。
  - **Copilot** (`OPENCODE_PROVIDER_ID=github-copilot`): `CopilotPollingAgent` が 1 回の `promptAsync()` で AI にバッファをポーリングさせる。全イベントを `FileEventBuffer` に JSONL で書き込み、AI が `event-buffer` MCP ツールで消費。1 セッションで全イベントを処理するためプロンプト課金を節約。
- **session-event-loop.ts（question ツールイベントループ）を除去。** `question.reply` がプロンプト1回分としてカウントされる問題を解消。
- セッションは `data/sessions.json` に JSON で永続化している。
  - メンション/スレッド: ユーザー単位セッション (`platform:channelId:authorId`)
  - ホームチャンネル: チャンネル単位共有セッション (`platform:channelId:_channel`)
- ブートストラップコンテキストはオーバーレイ方式で読込む: `data/context/` → `context/` のフォールバック。書き込みは常に `data/context/` に行う。
- チャンネル設定は `data/context/channels.json` → `context/channels.json` のフォールバックで管理する。
- MCP サーバーは `discord-server.ts`（Discord 操作）、`code-exec-server.ts`（コード実行）、`schedule-server.ts`（Heartbeat スケジュール管理）、`memory-server.ts`（メモリ・人格管理）、`event-buffer-server.ts`（イベントバッファ、Copilot 用）の 5 つ。
- **Heartbeat 自律行動システム: 1分間隔チェックループで due なリマインダーを検知し、AI セッションを起動して自律行動する。**
- **memory MCP サーバーで MEMORY.md / SOUL.md / LESSONS.md / 日次ログの構造化された読み書きが可能。**
- **Guild 跨ぎコンテキスト分離: 人格は全 Guild 共通、記憶（MEMORY, LESSONS, 日次ログ）は Guild ごとに分離。**
- `nr validate` (fmt:check + lint + check) および `bun test` が通る。
- Graceful shutdown（SIGINT/SIGTERM）実装済み。
- エラー時はユーザーに汎用メッセージを返し、詳細はログのみに記録する。
- ペルソナ（SOUL.md）を全面刷新。Anti-AI-Slop ルール、会話参加判断基準、感情表現パターンを追加。
- **ブートストラップコンテキストを OpenCode SDK の `system` フィールドで毎回注入するように変更。** OpenCode はセッション内で system をキャッシュしないため毎回送信が必須。Anthropic の Prompt Caching により同一内容のコスト増は緩和される。

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
12. プロバイダ別にイベント処理戦略を切り替える（Copilot → ポーリング、その他 → 同期 prompt）。

## 4. 既知のバグ・要修正事項

前回の 11 件は全て修正済み。新規の問題はなし。

## 5. 直近タスク

1. `context/channels.json` にホームチャンネル ID を設定して動作確認する
2. テスト用 Discord サーバーでの E2E 検証
3. judge プロンプトのチューニング（実際の会話で検証・調整）
4. infrastructure 層のテストカバレッジ拡充
5. ~~code-exec のコンテナ化によるサンドボックス実装~~ **完了** — Podman コンテナ化実装済み
6. ~~カスタム絵文字の使用頻度トラッキング~~ **完了** — 人気順トップ 20 フィルタリング実装済み

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. ~~code-exec のサンドボックス欠如による RCE リスク~~ **対策済み** — Podman コンテナ化（ネットワーク遮断、読み取り専用 rootfs、全ケーパビリティ削除、メモリ/CPU/PID 制限）。
2. judge の AI 呼び出しコスト（クールダウンで緩和済み、将来的に軽量モデル切り替えも検討）。
3. judge のレスポンスパース失敗時は ignore にフォールバック（安全側）。

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
