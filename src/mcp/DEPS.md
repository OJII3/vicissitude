# mcp/ 依存関係（自動生成）

> commit 時に自動再生成。手動編集禁止。

## ファイル依存関係図

```mermaid
graph LR
  code_exec_server["code-exec-server"]
  core_server["core-server"] --> http_server["http-server"]
  core_server["core-server"] --> tools_discord["tools/discord"]
  core_server["core-server"] --> tools_event_buffer["tools/event-buffer"]
  core_server["core-server"] --> tools_ltm["tools/ltm"]
  core_server["core-server"] --> tools_mc_bridge_discord["tools/mc-bridge-discord"]
  core_server["core-server"] --> tools_memory["tools/memory"]
  core_server["core-server"] --> tools_schedule["tools/schedule"]
  http_server["http-server"]
  memory_helpers["memory-helpers"]
  minecraft_actions_combat["minecraft/actions/combat"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_combat["minecraft/actions/combat"] --> minecraft_bot_queries["minecraft/bot-queries"]
  minecraft_actions_combat["minecraft/actions/combat"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_combat["minecraft/actions/combat"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_interaction["minecraft/actions/interaction"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_jobs["minecraft/actions/jobs"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_movement["minecraft/actions/movement"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_actions_survival_index["minecraft/actions/survival/index"]
  minecraft_actions_index["minecraft/actions/index"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_interaction["minecraft/actions/interaction"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_jobs["minecraft/actions/jobs"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_jobs["minecraft/actions/jobs"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_movement["minecraft/actions/movement"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_movement["minecraft/actions/movement"] --> minecraft_bot_queries["minecraft/bot-queries"]
  minecraft_actions_movement["minecraft/actions/movement"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_shared["minecraft/actions/shared"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_survival_escape["minecraft/actions/survival/escape"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_survival_escape["minecraft/actions/survival/escape"] --> minecraft_bot_queries["minecraft/bot-queries"]
  minecraft_actions_survival_escape["minecraft/actions/survival/escape"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_survival_food["minecraft/actions/survival/food"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_survival_index["minecraft/actions/survival/index"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_survival_index["minecraft/actions/survival/index"] --> minecraft_actions_survival_escape["minecraft/actions/survival/escape"]
  minecraft_actions_survival_index["minecraft/actions/survival/index"] --> minecraft_actions_survival_food["minecraft/actions/survival/food"]
  minecraft_actions_survival_index["minecraft/actions/survival/index"] --> minecraft_actions_survival_shelter["minecraft/actions/survival/shelter"]
  minecraft_actions_survival_index["minecraft/actions/survival/index"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_actions_survival_shelter["minecraft/actions/survival/shelter"] --> minecraft_actions_shared["minecraft/actions/shared"]
  minecraft_actions_survival_shelter["minecraft/actions/survival/shelter"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_auto_notifier["minecraft/auto-notifier"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_bot_connection["minecraft/bot-connection"] --> minecraft_bot_context["minecraft/bot-context"]
  minecraft_bot_connection["minecraft/bot-connection"] --> minecraft_bot_queries["minecraft/bot-queries"]
  minecraft_bot_connection["minecraft/bot-connection"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_bot_context["minecraft/bot-context"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_bot_queries["minecraft/bot-queries"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_brain_wake["minecraft/brain-wake"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_helpers["minecraft/helpers"]
  minecraft_http_server["minecraft/http-server"] --> http_server["http-server"]
  minecraft_job_manager["minecraft/job-manager"] --> minecraft_helpers["minecraft/helpers"]
  minecraft_mc_bridge_server["minecraft/mc-bridge-server"] --> tools_mc_bridge_minecraft["tools/mc-bridge-minecraft"]
  minecraft_mc_bridge_server["minecraft/mc-bridge-server"] --> tools_mc_memory["tools/mc-memory"]
  minecraft_mc_metrics["minecraft/mc-metrics"]
  minecraft_mcp_tools["minecraft/mcp-tools"] --> minecraft_actions_index["minecraft/actions/index"]
  minecraft_mcp_tools["minecraft/mcp-tools"] --> minecraft_bot_context["minecraft/bot-context"]
  minecraft_mcp_tools["minecraft/mcp-tools"] --> minecraft_bot_queries["minecraft/bot-queries"]
  minecraft_mcp_tools["minecraft/mcp-tools"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_mcp_tools["minecraft/mcp-tools"] --> minecraft_state_summary["minecraft/state-summary"]
  minecraft_server["minecraft/server"] --> minecraft_auto_notifier["minecraft/auto-notifier"]
  minecraft_server["minecraft/server"] --> minecraft_bot_connection["minecraft/bot-connection"]
  minecraft_server["minecraft/server"] --> minecraft_bot_context["minecraft/bot-context"]
  minecraft_server["minecraft/server"] --> minecraft_brain_wake["minecraft/brain-wake"]
  minecraft_server["minecraft/server"] --> minecraft_http_server["minecraft/http-server"]
  minecraft_server["minecraft/server"] --> minecraft_job_manager["minecraft/job-manager"]
  minecraft_server["minecraft/server"] --> minecraft_mc_metrics["minecraft/mc-metrics"]
  minecraft_server["minecraft/server"] --> minecraft_mcp_tools["minecraft/mcp-tools"]
  minecraft_state_summary["minecraft/state-summary"] --> minecraft_helpers["minecraft/helpers"]
  tools_discord["tools/discord"]
  tools_event_buffer["tools/event-buffer"]
  tools_ltm["tools/ltm"]
  tools_mc_bridge_discord["tools/mc-bridge-discord"] --> tools_mc_bridge_shared["tools/mc-bridge-shared"]
  tools_mc_bridge_minecraft["tools/mc-bridge-minecraft"] --> tools_mc_bridge_shared["tools/mc-bridge-shared"]
  tools_mc_bridge_shared["tools/mc-bridge-shared"]
  tools_mc_memory["tools/mc-memory"] --> memory_helpers["memory-helpers"]
  tools_memory["tools/memory"] --> memory_helpers["memory-helpers"]
  tools_schedule["tools/schedule"]
```

## ファイル別依存一覧

### code-exec-server.ts

- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/stdio.js, zod

### core-server.ts

- モジュール内依存: http-server, tools/discord, tools/event-buffer, tools/ltm, tools/mc-bridge-discord, tools/memory, tools/schedule
- 他モジュール依存: core/, ltm/, ollama/, opencode/, store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, discord.js, fs, path

### http-server.ts

- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js

### memory-helpers.ts

- 外部依存: fs, path, zod

### minecraft/actions/combat.ts

- モジュール内依存: minecraft/actions/shared, minecraft/bot-queries, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, mineflayer-pathfinder, prismarine-entity, zod

### minecraft/actions/index.ts

- モジュール内依存: minecraft/actions/combat, minecraft/actions/interaction, minecraft/actions/jobs, minecraft/actions/movement, minecraft/actions/shared, minecraft/actions/survival/index, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js

### minecraft/actions/interaction.ts

- モジュール内依存: minecraft/actions/shared
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, vec3, zod

### minecraft/actions/jobs.ts

- モジュール内依存: minecraft/actions/shared, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, mineflayer-pathfinder, prismarine-recipe, zod

### minecraft/actions/movement.ts

- モジュール内依存: minecraft/actions/shared, minecraft/bot-queries, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, mineflayer-pathfinder, prismarine-entity, zod

### minecraft/actions/shared.ts

- モジュール内依存: minecraft/job-manager
- 外部依存: mineflayer, mineflayer-pathfinder

### minecraft/actions/survival/escape.ts

- モジュール内依存: minecraft/actions/shared, minecraft/bot-queries, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer-pathfinder, zod

### minecraft/actions/survival/food.ts

- モジュール内依存: minecraft/actions/shared
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, zod

### minecraft/actions/survival/index.ts

- モジュール内依存: minecraft/actions/shared, minecraft/actions/survival/escape, minecraft/actions/survival/food, minecraft/actions/survival/shelter, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js

### minecraft/actions/survival/shelter.ts

- モジュール内依存: minecraft/actions/shared, minecraft/job-manager
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, mineflayer, mineflayer-pathfinder, vec3, zod

### minecraft/auto-notifier.ts

- モジュール内依存: minecraft/helpers
- 他モジュール依存: core/, store/

### minecraft/bot-connection.ts

- モジュール内依存: minecraft/bot-context, minecraft/bot-queries, minecraft/helpers
- 他モジュール依存: core/
- 外部依存: mineflayer, mineflayer-pathfinder, prismarine-entity, prismarine-viewer

### minecraft/bot-context.ts

- モジュール内依存: minecraft/helpers
- 他モジュール依存: core/
- 外部依存: mineflayer

### minecraft/bot-queries.ts

- モジュール内依存: minecraft/helpers
- 外部依存: mineflayer, prismarine-entity, vec3

### minecraft/brain-wake.ts

- モジュール内依存: minecraft/helpers
- 外部依存: fs, path

### minecraft/helpers.ts

- 依存なし

### minecraft/http-server.ts

- モジュール内依存: http-server

### minecraft/job-manager.ts

- モジュール内依存: minecraft/helpers
- 他モジュール依存: core/

### minecraft/mc-bridge-server.ts

- モジュール内依存: tools/mc-bridge-minecraft, tools/mc-memory
- 他モジュール依存: store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/stdio.js, path

### minecraft/mc-metrics.ts

- 他モジュール依存: core/

### minecraft/mcp-tools.ts

- モジュール内依存: minecraft/actions/index, minecraft/bot-context, minecraft/bot-queries, minecraft/job-manager, minecraft/state-summary
- 他モジュール依存: core/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, zod

### minecraft/server.ts

- モジュール内依存: minecraft/auto-notifier, minecraft/bot-connection, minecraft/bot-context, minecraft/brain-wake, minecraft/http-server, minecraft/job-manager, minecraft/mc-metrics, minecraft/mcp-tools
- 他モジュール依存: core/, store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js

### minecraft/state-summary.ts

- モジュール内依存: minecraft/helpers

### tools/discord.ts

- 他モジュール依存: infrastructure/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, discord.js, fs, path, zod

### tools/event-buffer.ts

- 他モジュール依存: store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, zod

### tools/ltm.ts

- 他モジュール依存: ltm/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, zod

### tools/mc-bridge-discord.ts

- モジュール内依存: tools/mc-bridge-shared
- 他モジュール依存: store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, zod

### tools/mc-bridge-minecraft.ts

- モジュール内依存: tools/mc-bridge-shared
- 他モジュール依存: store/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, zod

### tools/mc-bridge-shared.ts

- 他モジュール依存: store/

### tools/mc-memory.ts

- モジュール内依存: memory-helpers
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, fs, path, zod

### tools/memory.ts

- モジュール内依存: memory-helpers
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, fs, path, zod

### tools/schedule.ts

- 他モジュール依存: core/
- 外部依存: @modelcontextprotocol/sdk/server/mcp.js, fs, path, zod
