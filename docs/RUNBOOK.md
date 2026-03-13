# RUNBOOK.md

## 1. 目的

この文書は実行ルールである。
一度読んだら常に従う。

## 2. 不変ルール

1. Bot 自身のメッセージには反応しない。
2. Bot メンション、スレッド内メッセージ、ホームチャンネルメッセージを処理対象とする。
3. セッションはメンション/スレッドではチャンネル x ユーザー単位、ホームチャンネルではチャンネル単位で管理する。
4. 毎回のプロンプト送信時にブートストラップコンテキストを system prompt として注入する。
5. 応答は 2000 文字以内に分割して送信する。
6. 秘密情報をログやドキュメントに平文出力しない。
7. `STATUS.md` は作業ごとに更新する。
8. DI 配線は `bootstrap.ts` のみで行う。
9. `core/` は外部ライブラリに依存しない（Zod のみ例外として許可）。
10. `observability/` は `core/` のみに依存し、`agent/` や `gateway/` に依存しない。

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
9. Minecraft エージェントを使用する場合、以下を確認する:
   - `MC_HOST` が設定されていること（設定時のみ Minecraft エージェントが起動される）
   - `MC_PROVIDER_ID` / `MC_MODEL_ID`（省略時は Discord エージェントと同じプロバイダ・モデルを使用）

### 3.2 開発時コマンド

1. `nr dev` — watch モードで起動
2. `nr check` — 型チェック
3. `nr lint` — lint 実行
4. `nr lint:fix` — lint 自動修正
5. `nr fmt` — フォーマット
6. `nr fmt:check` — フォーマット確認
7. `nr validate` — fmt:check + lint + check 一括実行
8. `nr test:quality` — JUnit + LCOV からテスト品質サマリを生成（テスト失敗時もサマリ生成までは継続し、コマンド自体は非 0 で終了）
9. `nr test:quality:flake` — `bun test --rerun-each` でフレーク率を集計（flake 専用 JUnit のみを集計）

ソースコードを変更した場合、`nr validate` を実行して問題がないことを確認してからコミットすること。
テスト品質の観測が必要な変更では `nr test:quality` を実行し、`artifacts/test-quality/summary.md` を確認すること。
不安定なテストを疑う変更では `nr test:quality:flake` も実行すること。

### 3.3 デプロイ操作

1. `nr deploy` — Podman Compose で Bot コンテナを起動（バックグラウンド）
2. `nr deploy:logs` — 実行中コンテナのログをフォロー
3. `nr deploy:stop` — コンテナを停止・削除

**ソースコード・依存変更後のデプロイ手順:**

`nr deploy` が install → build → 起動を自動実行するため、イメージ再ビルドは不要:

```bash
nr deploy
```

**ベースイメージの再ビルドが必要な場合（bun バージョンやシステムパッケージ変更時のみ）:**

```bash
nr deploy:rebuild-base
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
  - ダッシュボード JSON の置き場所は `monitoring/grafana-dashboard.json` を正本とする
  - Overview / AI Performance / LTM / Heartbeat / LLM Sessions / Token Usage / Minecraft / Test Quality / Logs を含む
  - Log Volume by Level: レベル別ログボリュームの推移
  - Log Volume by Component: コンポーネント別ログボリュームの推移
  - Test Quality: `component="test-quality"` の JSON ログを Loki で可視化する
  - `nr test:quality` / `nr test:quality:flake` は Markdown サマリに加えて 1 行の JSON サマリも stdout へ出力する
  - 継続計測する場合は `artifacts/test-quality/history.ndjson` を Loki の収集対象に含める
  - Errors & Warnings: error/warn レベルのログのみ表示
  - All Logs: 全ログの検索・閲覧
  - Loki データソースの設定が必要（インポート時にプロンプトが表示される）
  - Minecraft パネルを使う場合、Prometheus が MC MCP プロセスの `/metrics`（既定 `9092`）も scrape していることを確認する

**注意:**

- イメージを再ビルドした後は `podman-compose up -d --force-recreate` でコンテナを再作成すること（`up -d` のみでは設定変更がない場合再作成されない）。
- `compose.yaml` の UID は 1000 にハードコードされている（Cipher ホスト専用）。異なる UID の環境では `compose.yaml` の修正が必要。

### 3.4 運用時の基本挙動

1. `messageCreate` イベントで Bot メンション / スレッド / ホームチャンネルを判定し、対象メッセージをイベントバッファへ積む。
2. Guild ごとの長寿命 `promptAsync()` セッションが `wait_for_events` ツールでイベントを継続消費する。
3. セッションが終了した場合のみ、終了理由をログで確認して必要に応じて再起動する。
4. AI エラー時はエラーメッセージを返信しログを記録する。

## 4. コンテキスト運用

AI には毎回のプロンプト送信時に以下を system prompt として渡す。
読み込みはオーバーレイ方式: `data/context/` -> `context/` の順でフォールバック。MCP ツールによる書き込みは常に `data/context/` に行われる。

1. `IDENTITY.md` — 名前・役割
2. `SOUL.md` — 人格・境界線
3. `AGENTS.md` — 操作ルール・ツール方針
4. `TOOLS.md` — MCP ツール一覧
5. `HEARTBEAT.md` — 定期チェック
6. `USER.md` — ユーザー情報
7. `MEMORY.md` — 長期記憶
8. `LESSONS.md` — 学習・教訓
9. `memory/{YYYY-MM-DD}.md` — 日次ログ（存在時）
10. `<minecraft-status>` セクション — マイクラの最近の出来事と目標（`McStatusProvider` 経由で動的注入、`config.minecraft` 設定時のみ）

※ Minecraft エージェント専用コンテキスト（Discord エージェントには直接含まれない）:

- `context/minecraft/MINECRAFT-IDENTITY.md` — 行動指針・報告基準・性格
- `context/minecraft/MINECRAFT-KNOWLEDGE.md` — ゲーム基礎知識
- `context/minecraft/MINECRAFT-GOALS.md` — 現在の目標のみ
- `context/minecraft/MINECRAFT-PROGRESS.md` — 装備段階・拠点・探索範囲・主要資源・達成済み目標・プレイヤーメモ
- `context/minecraft/MINECRAFT-SKILLS.md` — スキルライブラリ（常時注入なし、`mc_read_skills` で必要時に読む）

### 4.1 M13d マイグレーション（記憶ファイル再設計）

M13d 適用時に既存の `data/context/minecraft/MINECRAFT-GOALS.md` に「達成済み目標」「探索メモ」が残っている場合、手動で `MINECRAFT-PROGRESS.md` に移行する:

1. `data/context/minecraft/MINECRAFT-GOALS.md` を開き、「達成済み目標」「探索メモ」セクションの内容をコピーする
2. `data/context/minecraft/MINECRAFT-PROGRESS.md` を作成し、コピーした内容を適切なセクションに配置する
3. `MINECRAFT-GOALS.md` から「達成済み目標」「探索メモ」セクションを削除し、「現在の目標」のみ残す

## 5. 失敗時対応

1. AI 呼び出し失敗:
   - エラーメッセージを reply で返す。
   - 失敗理由をログで確認する。
2. セッション検証失敗:
   - 新規セッションを自動作成してリカバリする。
3. 設定不備:
   - 起動を中断する。
4. Minecraft エージェント停止:
   - `McBrainManager` がライフサイクルイベントを 10 秒間隔でポーリングして管理する。
   - セッションロックは 2 時間でタイムアウト。プロセス再起動時に自動クリアされる。
   - Minecraft エージェントの状態は `minecraft_status` ツールで確認可能。

## 6. 変更管理

1. 仕様変更は `SPEC.md` に反映する。
2. 実装方針変更は `PLAN.md` と `ARCHITECTURE.md` に反映する。
3. 運用ルール変更は `RUNBOOK.md` に反映する。
4. 進捗・現況は `STATUS.md` に反映する。
5. **PR をマージする前に `STATUS.md` を最新の状態に更新すること。** 完了したタスクの反映、直近タスクの更新、既知バグの追加・解消を含む。

## 7. コミット

- Conventional Commits 形式に従う。
- 形式: `<type>: <summary>`
- 1 コミット 1 目的を徹底する。
- 適切な粒度でコミットを行う。

## 8. Embedding モデル変更時のマイグレーション

embedding モデル（`LTM_EMBEDDING_MODEL`）を変更すると、新規 embedding の次元が既存データと異なる場合にエラーが発生する。以下の手順で再 embedding を行う。

### 8.1 手順

1. Bot を停止する。
2. 対象の LTM データベースをバックアップする:
   ```bash
   cp data/ltm/guilds/{guildId}/memory.db data/ltm/guilds/{guildId}/memory.db.bak
   ```
3. `.env` の `LTM_EMBEDDING_MODEL` を新モデルに変更する。
4. 既存の全 embedding を新モデルで再生成する。Ollama が起動していることを確認した上で、以下のように全レコードの embedding を更新する（id は UUID のためクォート展開は安全）:
   ```bash
   DB="data/ltm/guilds/{guildId}/memory.db"
   MODEL="新モデル名"
   OLLAMA="http://localhost:11434"

   # episodes の summary を再 embed
   sqlite3 "$DB" "SELECT id, summary FROM episodes;" | while IFS='|' read -r id text; do
     vec=$(curl -s "$OLLAMA/api/embed" -d "{\"model\":\"$MODEL\",\"input\":\"$text\"}" | jq -c '.embeddings[0]')
     sqlite3 "$DB" "UPDATE episodes SET embedding = '$(echo "$vec")' WHERE id = '$id';"
   done

   # semantic_facts の fact を再 embed
   sqlite3 "$DB" "SELECT id, fact FROM semantic_facts WHERE invalid_at IS NULL;" | while IFS='|' read -r id text; do
     vec=$(curl -s "$OLLAMA/api/embed" -d "{\"model\":\"$MODEL\",\"input\":\"$text\"}" | jq -c '.embeddings[0]')
     sqlite3 "$DB" "UPDATE semantic_facts SET embedding = '$(echo "$vec")' WHERE id = '$id';"
   done
   ```
5. embedding メタデータをリセットする（全レコード更新完了後に実行すること）:
   ```bash
   sqlite3 data/ltm/guilds/{guildId}/memory.db "DELETE FROM embedding_meta WHERE key = 'default';"
   ```
6. Bot を起動する。起動時のバックフィルで新しい次元が自動記録される。

### 8.2 注意事項

- メタデータリセット（Step 5）は必ず全 embedding の再生成（Step 4）が完了した後に行うこと。途中でリセットすると、バックフィルが未更新の古い embedding から誤った次元を推定する。
- データ量が多い場合は Ollama の負荷に注意する。

## 9. セキュリティ運用

1. `DISCORD_TOKEN` は `.env` で管理し、リポジトリにコミットしない。
2. エラーメッセージに内部情報を含めない（要修正、STATUS.md 参照）。
3. MCP code-exec サーバーは Podman コンテナでサンドボックス実行する。ホスト環境変数・ファイルシステムはコンテナ内からアクセス不可。
