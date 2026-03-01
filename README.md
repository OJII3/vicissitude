# Vicissitude

身内 Discord サーバー向けの会話 Bot「ふあ」。TypeScript + Bun で動作し、OpenCode + MCP を推論エンジンとして使用する。

## できること

- メンションやスレッドで話しかけると応答
- ホームチャンネルでは会話の流れを見て自律的に参加・リアクション・スルーを判断
- MCP ツールで Discord 操作、コード実行、スケジュール管理、自己記憶の更新が可能
- Guild ごとに記憶を分離

## セットアップ

```bash
bun install
cp .env.local.example .env.local
# .env.local に DISCORD_TOKEN を設定
bun run start
```

## コマンド

| コマンド           | 内容                          |
| ------------------ | ----------------------------- |
| `bun run start`    | 本番起動                      |
| `bun run dev`      | 開発モード (watch)            |
| `bun run check`    | 型チェック                    |
| `bun run lint`     | Lint                          |
| `bun run fmt`      | フォーマット                  |
| `bun run validate` | fmt:check + lint + check 一括 |

## ドキュメント

詳細は `docs/` を参照。
