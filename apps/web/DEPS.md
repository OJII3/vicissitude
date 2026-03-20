# apps/web/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  components_avatar_VrmViewer.tsx["components/avatar/VrmViewer.tsx"]
  components_chat_ChatPanel.tsx["components/chat/ChatPanel.tsx"] --> lib_ws_client["lib/ws-client"]
  index.css
  lib_audio_player["lib/audio-player"]
  lib_ws_client["lib/ws-client"]
  main.tsx --> index.css
  main.tsx --> routeTree.gen
  routeTree.gen --> routes___root.tsx["routes/__root.tsx"]
  routeTree.gen --> routes_index.tsx["routes/index.tsx"]
  routes___root.tsx["routes/__root.tsx"]
  routes_index.tsx["routes/index.tsx"] --> components_avatar_VrmViewer.tsx["components/avatar/VrmViewer.tsx"]
  routes_index.tsx["routes/index.tsx"] --> components_chat_ChatPanel.tsx["components/chat/ChatPanel.tsx"]
  vite_env.d["vite-env.d"]
```

## ファイル別依存一覧

### components/avatar/VrmViewer.tsx.ts

- 他モジュール依存: shared
- 外部依存: .bun, three/addons/loaders/GLTFLoader.js

### components/chat/ChatPanel.tsx.ts

- モジュール内依存: lib/ws-client
- 他モジュール依存: shared
- 外部依存: .bun

### index.css.ts

- 依存なし

### lib/audio-player.ts

- 依存なし

### lib/ws-client.ts

- 他モジュール依存: shared

### main.tsx.ts

- モジュール内依存: index.css, routeTree.gen
- 外部依存: .bun

### routeTree.gen.ts

- モジュール内依存: routes/\_\_root.tsx, routes/index.tsx

### routes/\_\_root.tsx.ts

- 外部依存: .bun

### routes/index.tsx.ts

- モジュール内依存: components/avatar/VrmViewer.tsx, components/chat/ChatPanel.tsx
- 他モジュール依存: shared
- 外部依存: .bun

### vite-env.d.ts

- 外部依存: .bun
