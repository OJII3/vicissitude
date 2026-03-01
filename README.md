## Vicissitude

Discord bot「ふあ」。OpenCode + MCP で動きます。

### セットアップ

```bash
bun install
cp .env.local.example .env.local
# .env.local に必要な環境変数を設定
bun run start
```

### コンテキストファイル

`context/` に bot の人格・記憶・操作ルールを定義:

| ファイル          | 用途                   |
| ----------------- | ---------------------- |
| `IDENTITY.md`     | 名前・役割             |
| `SOUL.md`         | 人格・境界線           |
| `AGENTS.md`       | 操作ルール・ツール方針 |
| `TOOLS.md`        | MCP ツール一覧         |
| `USER.md`         | ユーザー情報           |
| `MEMORY.md`       | 長期記憶               |
| `LESSONS.md`      | 学習・教訓             |
| `HEARTBEAT.md`    | 定期チェック           |
| `channels.json`   | チャンネル設定         |

### 使い方

- bot をメンション or スレッド内でメッセージ → ふあ が応答
