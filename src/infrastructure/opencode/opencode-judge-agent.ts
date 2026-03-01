import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";

import type { AgentResponse } from "../../domain/entities/agent-response.ts";
import type { AiAgent, SendOptions } from "../../domain/ports/ai-agent.port.ts";

/**
 * judge 専用の軽量 AiAgent 実装。
 * - MCP ツールなし（Discord 操作・コード実行不可）
 * - 毎回新規セッションを作成（ステートレス）
 * - コンテキスト注入なし
 */
export class OpencodeJudgeAgent implements AiAgent {
	private client: OpencodeClient | null = null;
	private closeServer: (() => void) | null = null;

	async send(options: SendOptions): Promise<AgentResponse> {
		const { message } = options;
		const oc = await this.getClient();

		const created = await oc.session.create({ body: { title: "ふあ:judge" } });
		if (!created.data) throw new Error("Failed to create judge session");
		const sessionId = created.data.id;

		const result = await oc.session.prompt({
			path: { id: sessionId },
			body: {
				parts: [{ type: "text", text: message }],
				model: {
					providerID: process.env.OPENCODE_PROVIDER_ID ?? "github-copilot",
					modelID: process.env.OPENCODE_MODEL_ID ?? "claude-sonnet-4.6",
				},
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
			sessionId,
		};
	}

	stop(): void {
		this.closeServer?.();
		this.client = null;
		this.closeServer = null;
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this.client) return this.client;

		// MCP サーバーなしで起動（judge にツールは不要）
		// 組み込みツールも全無効化（.env 等へのアクセス防止）
		// メインエージェント(4096)とポート競合しないよう別ポートを使用
		const result = await createOpencode({
			port: 4097,
			config: {
				tools: {
					read: false,
					glob: false,
					grep: false,
					edit: false,
					write: false,
					bash: false,
					webfetch: false,
					task: false,
					todowrite: false,
					skill: false,
				},
			},
		});

		this.client = result.client;
		this.closeServer = result.server.close;
		return this.client;
	}
}
