import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import {
	consumeBridgeEventsByType,
	insertBridgeEvent,
	peekBridgeEvents,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import { formatBridgeEvents } from "./mc-bridge-shared.ts";

const MAX_BRIDGE_MESSAGE_CHARS = 10_000;

export interface McBridgeDeps {
	db: StoreDb;
}

/** メインブレイン側のブリッジツールを登録する */
export function registerMainBrainBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

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
		{
			guild_id: z.string().min(1).describe("呼び出し元の guild ID"),
		},
		({ guild_id }) => {
			const lock = tryAcquireSessionLock(db, guild_id);
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

	server.tool(
		"minecraft_stop_session",
		"マイクラのセッションを停止する。",
		{
			guild_id: z.string().min(1).describe("呼び出し元の guild ID"),
		},
		({ guild_id }) => {
			const released = releaseSessionLockAndStop(db, guild_id);
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
		},
	);
}
