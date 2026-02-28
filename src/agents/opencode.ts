import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { AgentBackend, AgentResponse } from "./router.ts";
import { mcpServerConfigs } from "./mcp-config.ts";

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

export const opencodeAgent: AgentBackend = {
  name: "opencode",

  async send(sessionId, message) {
    const oc = await getClient();

    // セッション取得 or 作成
    let session: { id: string };
    try {
      const existing = await oc.session.get({ path: { id: sessionId } });
      session = existing.data!;
    } catch {
      const created = await oc.session.create({
        body: { title: `discord-${sessionId}` },
      });
      session = created.data!;
    }

    // プロンプト送信 (同期: 完了まで待機)
    const result = await oc.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: message }],
      },
    });

    // レスポンスからテキスト部分を抽出
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
      sessionId: session.id,
    };
  },

  async stop() {
    closeServer?.();
    client = null;
    closeServer = null;
  },
};
