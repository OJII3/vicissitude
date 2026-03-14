import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import { getSessionLockGuildId } from "../../store/mc-bridge.ts";
import { appendEvent } from "../../store/queries.ts";

const MAX_REPORT_CHARS = 10_000;

/** Minecraft 側のブリッジツールを登録する */
export function registerMinecraftBridgeTools(server: McpServer, deps: { db: StoreDb }): void {
	const { db } = deps;

	server.tool(
		"mc_report",
		"Discord 側にレポートを送信する。",
		{
			message: z.string().min(1).max(MAX_REPORT_CHARS).describe("レポート内容"),
			importance: z
				.enum(["low", "medium", "high", "critical"])
				.default("medium")
				.describe("重要度"),
			category: z
				.enum(["progress", "completion", "stuck", "danger", "discovery", "status"])
				.default("status")
				.describe(
					"レポート種別: progress=作業中間報告, completion=目標達成, stuck=行き詰まり, danger=危険回避, discovery=新発見, status=一般状態",
				),
		},
		({ message, importance, category }) => {
			const guildId = getSessionLockGuildId(db);
			if (!guildId) {
				return {
					content: [
						{
							type: "text" as const,
							text: "セッションが見つからない。レポートを送信できなかった。",
						},
					],
				};
			}
			const targetAgentId = `discord:${guildId}`;
			const event = {
				ts: new Date().toISOString(),
				content: message,
				authorId: "minecraft",
				authorName: "Minecraft Agent",
				messageId: `mc-report-${Date.now()}`,
				metadata: { type: "mc_report", importance, category },
			};
			appendEvent(db, targetAgentId, JSON.stringify(event));
			return {
				content: [{ type: "text" as const, text: "レポートを Discord 側に送信しました。" }],
			};
		},
	);
}
