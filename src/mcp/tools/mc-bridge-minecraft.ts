import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import { consumeBridgeEventsByType, insertBridgeEvent } from "../../store/mc-bridge.ts";
import { MAX_BRIDGE_MESSAGE_CHARS, formatBridgeEvents } from "./mc-bridge-shared.ts";

/** Minecraft 側のブリッジツールを登録する */
export function registerMinecraftBridgeTools(server: McpServer, deps: { db: StoreDb }): void {
	const { db } = deps;

	server.tool(
		"mc_report",
		"Discord 側にレポートを送信する。",
		{
			message: z.string().min(1).max(MAX_BRIDGE_MESSAGE_CHARS).describe("レポート内容"),
			importance: z
				.enum(["low", "medium", "high", "critical"])
				.default("medium")
				.describe("重要度"),
		},
		({ message, importance }) => {
			const payload = JSON.stringify({ message, importance });
			insertBridgeEvent(db, "to_discord", "report", payload);
			return {
				content: [{ type: "text" as const, text: "レポートを Discord 側に送信しました。" }],
			};
		},
	);

	server.tool("mc_read_commands", "Discord 側からの指示を消費して読む。", {}, () => {
		const events = consumeBridgeEventsByType(db, "to_minecraft", "command");
		if (events.length === 0) {
			return {
				content: [{ type: "text" as const, text: "新しい指示はありません。" }],
			};
		}
		return {
			content: [{ type: "text" as const, text: formatBridgeEvents(events) }],
		};
	});
}
