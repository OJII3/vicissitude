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
		"マイクラの自分に指示を出す。次のポーリングで反映される。",
		{
			command: z.string().min(1).max(MAX_BRIDGE_MESSAGE_CHARS).describe("マイクラでやること"),
		},
		({ command }) => {
			insertBridgeEvent(db, "to_sub", "command", command);
			return {
				content: [{ type: "text" as const, text: "指示を出した。あとでやっとく。" }],
			};
		},
	);

	server.tool("minecraft_status", "マイクラでの最近の出来事を確認する（消費しない）。", {}, () => {
		const events = peekBridgeEvents(db, "to_main", 50);
		if (events.length === 0) {
			return {
				content: [{ type: "text" as const, text: "特に何もなかった。" }],
			};
		}
		return {
			content: [{ type: "text" as const, text: formatBridgeEvents(events) }],
		};
	});

	server.tool("minecraft_read_reports", "マイクラでの出来事を確認済みにして読む。", {}, () => {
		const events = consumeBridgeEventsByType(db, "to_main", "report");
		if (events.length === 0) {
			return {
				content: [{ type: "text" as const, text: "新しい出来事はなかった。" }],
			};
		}
		return {
			content: [{ type: "text" as const, text: formatBridgeEvents(events) }],
		};
	});

	server.tool(
		"minecraft_start_session",
		"マイクラのセッションを開始する。マイクラが停止中のときに使う。",
		{},
		() => {
			const lock = tryAcquireSessionLock(db, guildId);
			if (!lock.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: "セッション開始に失敗した。別のセッションが動いてる。",
						},
					],
				};
			}
			insertBridgeEvent(db, "to_sub", "lifecycle", "start");
			return {
				content: [
					{
						type: "text" as const,
						text: "マイクラ起動するね。ちょっと待って。",
					},
				],
			};
		},
	);

	server.tool("minecraft_stop_session", "マイクラのセッションを停止する。", {}, () => {
		const released = releaseSessionLockAndStop(db, guildId);
		if (!released) {
			return {
				content: [
					{
						type: "text" as const,
						text: "停止に失敗した。セッションが動いてないみたい。",
					},
				],
			};
		}
		return {
			content: [
				{
					type: "text" as const,
					text: "マイクラ止めた。",
				},
			],
		};
	});
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
