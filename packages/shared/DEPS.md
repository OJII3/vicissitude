# shared/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  config
  emotion
  functions
  ports --> emotion
  ports --> tts
  ports --> ws_protocol["ws-protocol"]
  tts --> emotion
  types --> emotion
  ws_protocol["ws-protocol"] --> emotion
```

## ファイル別依存一覧

### config.ts

- 外部依存: path

### emotion.ts

- 外部依存: .bun

### functions.ts

- 依存なし

### ports.ts

- モジュール内依存: emotion, tts, ws-protocol

### tts.ts

- モジュール内依存: emotion
- 外部依存: .bun

### types.ts

- モジュール内依存: emotion

### ws-protocol.ts

- モジュール内依存: emotion
- 外部依存: .bun
