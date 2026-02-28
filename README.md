## Vicissitude

OpenClaw インスパイアの、Discord bot です。OpenCode + Copilot Agent + MCP で動きます。

### セットアップ

```bash
bun install
cp .env.local.example .env.local
# .env.local に DISCORD_TOKEN と GITHUB_TOKEN を設定
bun start
```

### `.env.local`

```
DISCORD_TOKEN=your_discord_bot_token
GITHUB_TOKEN=your_github_token
```

### コマンド

- `/agent switch <name>` - agent 切り替え (opencode / copilot)
- `/agent list` - 利用可能な agent 一覧
- bot をメンション or スレッド内でメッセージ → AI が応答
