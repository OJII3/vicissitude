import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import type { BridgeEvent } from "../../store/mc-bridge.ts";
import { consumeBridgeEvents, insertBridgeEvent, peekBridgeEvents } from "../../store/mc-bridge.ts";

const MAX_BRIDGE_MESSAGE_CHARS = 10_000;

export interface McBridgeDeps {
	db: StoreDb;
}

function formatBridgeEvents(events: BridgeEvent[]): string {
	const formatted = events.map((e) => ({
		id: e.id,
		type: e.type,
		payload: e.payload,
		createdAt: new Date(e.createdAt).toISOString(),
	}));
	return JSON.stringify(formatted, null, 2);
}

/** メインブレイン側のブリッジツールを登録する */
export function registerMainBrainBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

	server.tool(
		"minecraft_delegate",
		"Minecraft サブブレインに指示を送る。サブブレインが次のポーリングで受け取る。",
		{
			command: z.string().min(1).max(MAX_BRIDGE_MESSAGE_CHARS).describe("サブブレインへの指示内容"),
		},
		({ command }) => {
			insertBridgeEvent(db, "to_sub", "command", command);
			return {
				content: [{ type: "text" as const, text: "指示をサブブレインに送信しました。" }],
			};
		},
	);

	server.tool(
		"minecraft_status",
		"Minecraft サブブレインからのレポートを覗き見する（消費しない）。",
		{},
		() => {
			const events = peekBridgeEvents(db, "to_main");
			if (events.length === 0) {
				return {
					content: [{ type: "text" as const, text: "レポートはありません。" }],
				};
			}
			return {
				content: [{ type: "text" as const, text: formatBridgeEvents(events) }],
			};
		},
	);

	server.tool(
		"minecraft_read_reports",
		"Minecraft サブブレインからのレポートを消費して読む。",
		{},
		() => {
			const events = consumeBridgeEvents(db, "to_main");
			if (events.length === 0) {
				return {
					content: [{ type: "text" as const, text: "新しいレポートはありません。" }],
				};
			}
			return {
				content: [{ type: "text" as const, text: formatBridgeEvents(events) }],
			};
		},
	);
}

/** サブブレイン側のブリッジツールを登録する */
export function registerSubBrainBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

	server.tool(
		"mc_report",
		"メインブレインにレポートを送信する。",
		{
			message: z.string().min(1).max(MAX_BRIDGE_MESSAGE_CHARS).describe("レポート内容"),
			importance: z
				.enum(["low", "medium", "high", "critical"])
				.default("medium")
				.describe("重要度"),
		},
		({ message, importance }) => {
			const payload = JSON.stringify({ message, importance });
			insertBridgeEvent(db, "to_main", "report", payload);
			return {
				content: [{ type: "text" as const, text: "レポートをメインブレインに送信しました。" }],
			};
		},
	);

	server.tool("mc_read_commands", "メインブレインからの指示を消費して読む。", {}, () => {
		const events = consumeBridgeEvents(db, "to_sub");
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
