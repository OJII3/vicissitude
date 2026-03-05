# RUNBOOK.md

## 1. 目的

この文書は実行ルールである。
一度読んだら常に従う。

## 2. 不変ルール

1. Bot 自身のメッセージには反応しない。
2. Bot メンション、スレッド内メッセージ、ホームチャンネルメッセージを処理対象とする。
3. セッションはメンション/スレッドではチャンネル × ユーザー単位、ホームチャンネルではチャンネル単位で管理する。
4. 毎回のプロンプト送信時にブートストラップコンテキストを system prompt として注入する。
5. 応答は 2000 文字以内に分割して送信する。
6. 秘密情報をログやドキュメントに平文出力しない。
7. `STATUS.md` は作業ごとに更新する。
8. Clean Architecture の依存方向ルールに違反しない。
9. DI 配線は `composition-root.ts` のみで行う。

## 3. 実行手順

### 3.1 起動前チェック

1. `.env` に `DISCORD_TOKEN` が設定されていることを確認する。
2. `context/` ディレクトリにブートストラップファイル（ベース）が配置されていることを確認する。
3. `data/` ディレクトリが書き込み可能であることを確認する。
4. デプロイ固有のチャンネル設定がある場合、`data/context/channels.json` に配置する（なければ `context/channels.json` がフォールバックとして使われる）。
5. `podman --version` および `podman-compose --version` が実行可能であることを確認する。
6. Podman ソケットが有効化されていることを確認する:
   ```bash
   systemctl --user enable --now podman.socket
   ```
7. opencode の GitHub Copilot 認証が完了していることを確認する。`~/.local/share/opencode/auth.json` が存在しない場合は `opencode auth` で認証を行う:
   ```bash
   ls ~/.local/share/opencode/auth.json || opencode auth
   ```
8. `nr container:build:all` でコンテナイメージをビルド済みであることを確認する。

### 3.2 開発時コマンド

1. `nr dev` — watch モードで起動
2. `nr check` — 型チェック
3. `nr lint` — lint 実行
4. `nr lint:fix` — lint 自動修正
5. `nr fmt` — フォーマット
6. `nr fmt:check` — フォーマット確認
7. `nr validate` — fmt:check + lint + check 一括実行

ソースコードを変更した場合、`nr validate` を実行して問題がないことを確認してからコミットすること。

### 3.3 デプロイ操作

1. `nr deploy` — Podman Compose で Bot コンテナを起動（バックグラウンド）
2. `nr deploy:logs` — 実行中コンテナのログをフォロー
3. `nr deploy:stop` — コンテナを停止・削除

**ソースコード変更後のデプロイ手順:**

ソースコードはコンテナイメージに `COPY` されているため、変更後はリビルドが必要:

```bash
nr deploy:rebuild
```

**ログ確認:**

- コンテナは `journald` ログドライバーを使用しており、ログは JSON 構造化形式（NDJSON）でシステムジャーナルに記録される。
- `nr deploy:logs` (`podman-compose logs -f`) でも確認可能。
- journald から直接確認する場合:
  ```bash
  journalctl CONTAINER_TAG=vicissitude -f          # リアルタイム表示
  journalctl CONTAINER_TAG=vicissitude --no-pager -n 100  # 直近 100 行
  ```
- **Grafana ダッシュボード** (`monitoring/grafana-dashboard.json`) の Logs セクションでも確認可能:
  - Log Volume by Level: レベル別ログボリュームの推移
  - Log Volume by Component: コンポーネント別ログボリュームの推移
  - Errors & Warnings: error/warn レベルのログのみ表示
  - All Logs: 全ログの検索・閲覧
  - Loki データソースの設定が必要（インポート時にプロンプトが表示される）

**注意:**

- イメージを再ビルドした後は `podman-compose up -d --force-recreate` でコンテナを再作成すること（`up -d` のみでは設定変更がない場合再作成されない）。
- `compose.yaml` の UID は 1000 にハードコードされている（Cipher ホスト専用）。異なる UID の環境では `compose.yaml` の修正が必要。

### 3.4 運用時の基本挙動

1. `messageCreate` イベントで Bot メンション / スレッドを判定する。
2. メンション文字列を除去してメッセージを AI に渡す。
3. AI 応答を分割して Discord に返信する。
4. AI エラー時はエラーメッセージを返信しログを記録する。

## 4. コンテキスト運用

AI には毎回のプロンプト送信時に以下を system prompt として渡す。
読み込みはオーバーレイ方式: `data/context/` → `context/` の順でフォールバック。MCP ツールによる書き込みは常に `data/context/` に行われる。

1. `IDENTITY.md` — 名前・役割
2. `SOUL.md` — 人格・境界線
3. `AGENTS.md` — 操作ルール・ツール方針
4. `TOOLS.md` — MCP ツール一覧
5. `HEARTBEAT.md` — 定期チェック
6. `USER.md` — ユーザー情報
7. `MEMORY.md` — 長期記憶
8. `LESSONS.md` — 学習・教訓
9. `memory/{YYYY-MM-DD}.md` — 日次ログ（存在時）

## 5. 失敗時対応

1. AI 呼び出し失敗:
   - エラーメッセージを reply で返す。
   - 失敗理由をログで確認する。
2. セッション検証失敗:
   - 新規セッションを自動作成してリカバリする。
3. 設定不備:
   - 起動を中断する。

## 6. 変更管理

1. 仕様変更は `SPEC.md` に反映する。
2. 実装方針変更は `PLAN.md` と `ARCHITECTURE.md` に反映する。
3. 運用ルール変更は `RUNBOOK.md` に反映する。
4. 進捗・現況は `STATUS.md` に反映する。

## 7. コミット

- Conventional Commits 形式に従う。
- 形式: `<type>: <summary>`
- 1 コミット 1 目的を徹底する。
- 適切な粒度でコミットを行う。

## 8. セキュリティ運用

1. `DISCORD_TOKEN` は `.env` で管理し、リポジトリにコミットしない。
2. エラーメッセージに内部情報を含めない（要修正、STATUS.md 参照）。
3. MCP code-exec サーバーは Podman コンテナでサンドボックス実行する。ホスト環境変数・ファイルシステムはコンテナ内からアクセス不可。
