import { resolve } from "path";

/**
 * MCP サーバー設定を返す。OpenCode / Copilot 両方から使う共通設定。
 */
export function mcpServerConfigs() {
  const root = resolve(import.meta.dirname, "../..");

  return {
    "discord": {
      type: "local" as const,
      command: ["bun", "run", resolve(root, "src/mcp/discord-server.ts")],
      environment: {
        DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
      },
    },
    "code-exec": {
      type: "local" as const,
      command: ["bun", "run", resolve(root, "src/mcp/code-exec-server.ts")],
    },
  };
}
