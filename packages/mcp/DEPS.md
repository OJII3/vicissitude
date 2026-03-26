# mcp/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  code_exec_server["code-exec-server"]
  core_server["core-server"] --> http_server["http-server"]
  core_server["core-server"] --> tool_metrics["tool-metrics"]
  core_server["core-server"] --> tools_discord["tools/discord"]
  core_server["core-server"] --> tools_event_buffer["tools/event-buffer"]
  core_server["core-server"] --> tools_mc_bridge_discord["tools/mc-bridge-discord"]
  core_server["core-server"] --> tools_memory["tools/memory"]
  core_server["core-server"] --> tools_schedule["tools/schedule"]
  http_server["http-server"]
  memory_helpers["memory-helpers"]
  tool_metrics["tool-metrics"]
  tools_discord["tools/discord"]
  tools_event_buffer["tools/event-buffer"]
  tools_mc_bridge_discord["tools/mc-bridge-discord"]
  tools_mc_bridge_minecraft["tools/mc-bridge-minecraft"] --> tools_event_buffer["tools/event-buffer"]
  tools_mc_memory["tools/mc-memory"] --> memory_helpers["memory-helpers"]
  tools_memory["tools/memory"]
  tools_schedule["tools/schedule"]
```

## ファイル別依存一覧

### code-exec-server.ts

- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/stdio.js

### core-server.ts

- モジュール内依存: http-server, tool-metrics, tools/discord, tools/event-buffer, tools/mc-bridge-discord, tools/memory, tools/schedule
- 他モジュール依存: memory, observability, ollama, shared, store
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js, fs, path

### http-server.ts

- 他モジュール依存: shared
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js

### memory-helpers.ts

- 他モジュール依存: shared
- 外部依存: fs, path

### tool-metrics.ts

- 外部依存: @modelcontextprotocol/sdk/server/mcp.js

### tools/discord.ts

- 他モジュール依存: infrastructure
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js, fs, path

### tools/event-buffer.ts

- 他モジュール依存: memory, shared, store
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js

### tools/mc-bridge-discord.ts

- 他モジュール依存: shared, store
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js

### tools/mc-bridge-minecraft.ts

- モジュール内依存: tools/event-buffer
- 他モジュール依存: shared, store
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js

### tools/mc-memory.ts

- モジュール内依存: memory-helpers
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js, fs, path

### tools/memory.ts

- 他モジュール依存: memory
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js

### tools/schedule.ts

- 他モジュール依存: shared
- 外部依存: .bun, @modelcontextprotocol/sdk/server/mcp.js, fs, path
