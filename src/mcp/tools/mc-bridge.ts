import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import type { BridgeEvent } from "../../store/mc-bridge.ts";
import {
	consumeBridgeEventsByType,
	insertBridgeEvent,
	peekBridgeEvents,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";

const MAX_BRIDGE_MESSAGE_CHARS = 10_000;

export interface McBridgeDeps {
	db: StoreDb;
	guildId: string;
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
	const { db, guildId } = deps;

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
			const events = consumeBridgeEventsByType(db, "to_main", "report");
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

	server.tool(
		"minecraft_start_session",
		"Minecraft サブブレインのセッションを開始する。サブブレインが起動していない場合に使用。",
		{},
		() => {
			const lock = tryAcquireSessionLock(db, guildId);
			if (!lock.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: "セッション開始に失敗しました。別のセッションが使用中です。",
						},
					],
				};
			}
			insertBridgeEvent(db, "to_sub", "lifecycle", "start");
			return {
				content: [
					{
						type: "text" as const,
						text: "サブブレインに開始指示を送信しました。起動まで少し時間がかかる場合があります。",
					},
				],
			};
		},
	);

	server.tool(
		"minecraft_stop_session",
		"Minecraft サブブレインのセッションを停止する。",
		{},
		() => {
			const released = releaseSessionLockAndStop(db, guildId);
			if (!released) {
				return {
					content: [
						{
							type: "text" as const,
							text: "ロック解放に失敗しました。このギルドはセッションを保持していません。",
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: "サブブレインに停止指示を送信しました。",
					},
				],
			};
		},
	);
}

/** サブブレイン側のブリッジツールを登録する */
export function registerSubBrainBridgeTools(server: McpServer, deps: { db: StoreDb }): void {
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
		const events = consumeBridgeEventsByType(db, "to_sub", "command");
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
