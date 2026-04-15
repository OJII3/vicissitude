# ポーリングモデル（半無限セッション）

## 概要

Copilot はリクエスト単位のチケット制課金のため、1回の `promptAsync` で LLM セッションを起動し、
LLM 自身が MCP ツール `wait_for_events` を繰り返し呼び出すことで **セッションを終了させずに半永続的に動作させる**。
これにより追加のプロンプト送信（＝追加チケット消費）なしでイベント駆動の応答を実現する。

```
┌─────────────────────────────────────────────────────────┐
│  1回の promptAsync                                       │
│                                                         │
│  LLM: wait_for_events() ──timeout──→ wait_for_events()  │
│        │                                │               │
│        ├─ events arrive → respond ──→ wait_for_events() │
│        │                                │               │
│        └─ (このループが半永続的に続く)    ...             │
└─────────────────────────────────────────────────────────┘
```

## コンポーネント間の関係

```
Discord Gateway
    │
    ▼
EventBuffer (SQLite)  ←── append()
    │
    ▼
wait_for_events (MCP ツール)  ←── LLM が呼び出す
    │  consumeEvents() で SQLite から読み取り・削除
    ▼
LLM が応答テキスト生成 → send_message (MCP ツール) → Discord
    │
    ▼
wait_for_events() を再度呼び出し（ループ）
```

### 各ファイルの役割

| ファイル | 役割 |
|---|---|
| `packages/mcp/src/tools/event-buffer.ts` | `wait_for_events` MCP ツール。SQLite をポーリングしてイベントを消費・返却 |
| `packages/store/src/event-buffer.ts` | `SqliteEventBuffer` — イベントの append と waitForEvents（初回起動用） |
| `packages/agent/src/runner.ts` | `AgentRunner` — セッションライフサイクル管理。初回イベント到着でセッション起動 |
| `packages/opencode/src/session-adapter.ts` | OpenCode Go バイナリとの通信アダプタ。`mcp_timeout` を十分大きく設定 |

## 既知の問題

### OpenCode Go バイナリの MCP タイムアウト

`experimental.mcp_timeout` を 3日に設定しているが、OpenCode Go バイナリが
この値を正しく適用していない疑いがある。`wait_for_events` の MCP ツール呼び出しが
"The operation timed out." エラーで失敗するケースが観測されている。

これにより:
1. `wait_for_events` が途中でタイムアウト → LLM は再度 `wait_for_events` を呼ぶ
2. タイムアウト中にイベントが消費（SQLite DELETE）されていた場合、そのイベントは失われる
3. セッションが長時間稼働すると、コンテキストがタイムアウトループで埋まり応答不能になる

### 対策の方向性

MCP HTTP 通信に依存しない方式（function calling 直接注入など）への移行を検討中。
