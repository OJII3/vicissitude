# STATUS.md

## 1. 最終更新

- 2026-03-01
- 更新者: AI

## 2. 現在の真実（Project Truth）

- Clean Architecture への移行が完了している（`feat/clean-architecture` ブランチ、未マージ）。
- domain / application / infrastructure の 3 層構成で、依存方向ルールは正しく守られている。
- DI は手動コンストラクタ注入（Pure DI）で `composition-root.ts` に集約している。
- テストは一切存在しない。
- Bot メンションまたはスレッド内メッセージに AI が応答する。
- AI 推論は OpenCode SDK 経由で `github-copilot:claude-sonnet-4.6` を使用する。
- セッションは `data/sessions.json` に JSON で永続化している。
- ブートストラップコンテキストは `context/` 配下の Markdown から読込む。
- MCP サーバーは `discord-server.ts`（Discord 操作）と `code-exec-server.ts`（コード実行）の 2 つ。
- `nr validate` (fmt:check + lint + check) は通る。

## 3. 確定済み方針

1. 人格名は「ふあ」。
2. TypeScript + Bun ランタイム。
3. Clean Architecture + Ports and Adapters。
4. Pure DI（DI コンテナなし）。
5. MCP サーバーは独立プロセスとしてレイヤー外に配置。
6. `STATUS.md` は作業ごとに更新する。

## 4. 既知のバグ・要修正事項

コードレビューで検出された問題を優先度順に記載する。

### Critical

- [x] **`isNew` 判定バグ** — `opencode-agent.ts:22`
  - OpenCode 側でセッションが削除された場合、セッションを再作成するが `isNew` が `false` のままとなり、ブートストラップコンテキストが注入されない。
  - 修正済み: `isNew` の判定をセッションリカバリ処理の後に移し、セッション再作成時にフラグを立て直すようにした。

- [x] **エラーメッセージの Discord 漏洩** — `handle-incoming-message.use-case.ts:35`
  - `error.message` がそのまま `reply()` で送信される。内部パス・API エンドポイント等が露出する可能性。
  - 修正済み: ユーザー向けには汎用エラーメッセージを返し、詳細はログのみに記録するようにした。

- [x] **テストがゼロ** — プロジェクト全体
  - Clean Architecture の利点（テスタビリティ）が活かされていない。
  - 修正済み: `splitMessage()` と `HandleIncomingMessageUseCase` のテストを追加。`package.json` に `"test": "bun test"` を追加。

### Important

- [x] **セッションファイルの同時書き込み競合** — `json-session-repository.ts:57-60`
  - 複数の Discord メッセージ同時処理で `Bun.write()` が同一ファイルに並行書き込みし、ファイル破損の可能性。
  - 修正済み: async IIFE による書き込み直列化を実装した。

- [x] **ユースケースが `"discord"` をハードコード** — `handle-incoming-message.use-case.ts:18`
  - application 層がプラットフォーム固有の文字列を知っている（Clean Architecture 違反）。
  - 修正済み: `IncomingMessage` に `platform: string` フィールドを追加し、`DiscordGateway` で設定するようにした。

- [x] **`DiscordGateway` が `Logger` を未使用** — `discord-gateway.ts:32`
  - `ConsoleLogger` を DI で定義しているのに、`DiscordGateway` では直接 `console.log` を使用。
  - 修正済み: `DiscordGateway` のコンストラクタで `Logger` を受け取り、`this.logger.info()` を使用するようにした。

### Minor

- [x] **`splitMessage` の改行処理** — `message-formatter.ts:16`
  - 改行位置で分割した際、改行文字が次チャンクの先頭に残る。
  - 修正済み: `remaining.slice(splitAt + 1)` で改行をスキップするようにした。

- [x] **`splitMessage` の Discord 固有定数** — `message-formatter.ts:1`
  - `MAX_DISCORD_LENGTH = 2000` が domain 層にハードコードされている。
  - 修正済み: `maxLength` をパラメータ化した（デフォルト値 2000 を維持）。

- [x] **Graceful shutdown 未実装** — `composition-root.ts`
  - `SIGINT`/`SIGTERM` ハンドラがなく、`gateway.stop()` / `agent.stop()` が呼ばれない。
  - 修正済み: `bootstrap()` 内で SIGINT/SIGTERM シグナルハンドラを追加した。

- [x] **`package.json` の `lint:fix` が CLAUDE.md に未記載**
  - 確認済み: CLAUDE.md にはすでに `nr lint:fix` が記載されていた。

### セキュリティ

- [x] **code-exec MCP サーバーにサンドボックスなし** — `mcp/code-exec-server.ts`
  - ツール説明文には "sandboxed" と記載されているが、実際にはサンドボックス未実装。任意コマンドがホスト上で実行される。
  - 修正済み: 説明文を `"Execute code and return the output (NOT sandboxed — runs on host)"` に変更した。

- [x] **子プロセスへの環境変数継承** — `mcp/code-exec-server.ts`
  - `Bun.spawn` がデフォルトで親プロセスの環境変数を継承するため、`DISCORD_TOKEN` 等が code-exec 内のコードから参照可能。
  - 修正済み: `Bun.spawn` の `env` に `SAFE_ENV`（PATH, HOME, LANG のみ）を明示的に指定した。

## 5. 直近タスク

1. ~~Critical バグの修正（`isNew` 判定、エラーメッセージ漏洩）~~ — 完了
2. ~~テスト追加（`splitMessage`, `HandleIncomingMessageUseCase`）~~ — 完了
3. ~~セッション書き込み競合対策~~ — 完了
4. テストカバレッジの拡充（infrastructure 層のテスト等）

## 6. ブロッカー

- なし。

## 7. リスクメモ

1. ~~テストゼロ状態でのリグレッションリスク。~~ — テスト追加済み（10件）
2. code-exec のサンドボックス欠如による RCE リスク（説明文は修正済み、コンテナ化は未対応）。
3. ~~セッションファイル競合によるデータ破損リスク。~~ — 書き込み直列化で対応済み

## 8. 再開時コンテキスト

再開時は以下の順で確認する。

1. `docs/SPEC.md`
2. `docs/PLAN.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RUNBOOK.md`
5. 本ファイル `docs/STATUS.md`
