import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AgentBackend, AgentResponse } from "./router.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

let client: CopilotClient | null = null;
const sessions = new Map<string, any>();

function getClient(): CopilotClient {
  if (client) return client;
  client = new CopilotClient({
    githubToken: process.env.GITHUB_TOKEN,
  });
  return client;
}

function buildMcpServers(): Record<string, any> {
  const configs = mcpServerConfigs();
  const result: Record<string, any> = {};

  for (const [name, config] of Object.entries(configs)) {
    if (config.type === "local") {
      result[name] = {
        type: "stdio",
        command: config.command[0],
        args: config.command.slice(1),
        env: "environment" in config ? config.environment : undefined,
        tools: ["*"],
      };
    }
  }

  return result;
}

export const copilotAgent: AgentBackend = {
  name: "copilot",

  async send(sessionId, message) {
    const cp = getClient();

    let session = sessions.get(sessionId);
    if (!session) {
      session = await cp.createSession({
        onPermissionRequest: approveAll,
        mcpServers: buildMcpServers(),
        streaming: false,
      });
      sessions.set(sessionId, session);
    }

    const reply = await session.sendAndWait({ prompt: message }, 60_000);

    return {
      text: reply?.data?.content ?? "(no response)",
      sessionId,
    };
  },

  async stop() {
    await client?.stop();
    client = null;
    sessions.clear();
  },
};
