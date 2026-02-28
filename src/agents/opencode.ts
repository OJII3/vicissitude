import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { AgentResponse } from "./types.ts";
import { mcpServerConfigs } from "./mcp-config.ts";
import { getSessionId, setSessionId, isNewSession } from "../sessions.ts";
import { wrapWithContext } from "../context.ts";

let client: OpencodeClient | null = null;
let closeServer: (() => void) | null = null;

async function getClient(): Promise<OpencodeClient> {
  if (client) return client;

  const result = await createOpencode({
    config: {
      mcp: mcpServerConfigs(),
    },
  });

  client = result.client;
  closeServer = result.server.close;
  return client;
}

export const opencodeAgent = {
  async send(sessionKey: string, message: string): Promise<AgentResponse> {
    const oc = await getClient();
    const isNew = isNewSession("opencode", sessionKey);

    // 既存セッション ID を取得、なければ新規作成
    let realId = getSessionId("opencode", sessionKey);

    if (realId) {
      // 既存セッションが実際に存在するか確認
      try {
        await oc.session.get({ path: { id: realId } });
      } catch {
        realId = undefined;
      }
    }

    if (!realId) {
      const created = await oc.session.create({
        body: { title: `ふあ:${sessionKey}` },
      });
      realId = created.data!.id;
      await setSessionId("opencode", sessionKey, realId);
    }

    // 新規セッションならブートストラップコンテキストを注入
    const prompt = isNew ? await wrapWithContext(message) : message;

    const result = await oc.session.prompt({
      path: { id: realId },
      body: {
        parts: [{ type: "text", text: prompt }],
        model: { providerID: "copilot", modelID: "claude-sonnet-4-6" },
      },
    });

    const texts: string[] = [];
    if (result.data?.parts) {
      for (const part of result.data.parts) {
        if (part.type === "text") {
          texts.push(part.text);
        }
      }
    }

    return {
      text: texts.join("\n") || "(no response)",
      sessionId: realId,
    };
  },

  async stop() {
    closeServer?.();
    client = null;
    closeServer = null;
  },
};
