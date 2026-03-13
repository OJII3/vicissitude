import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { StoreDb } from "../../store/db.ts";
import {
	consumeBridgeEventsByType,
	getMcConnectionStatus,
	insertBridgeEvent,
	peekBridgeEvents,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import {
	MAX_BRIDGE_MESSAGE_CHARS,
	formatBridgeEvents,
	formatStatusEvents,
} from "./mc-bridge-shared.ts";

export interface McBridgeDeps {
	db: StoreDb;
}

/** Discord 側のブリッジツールを登録する */
export function registerDiscordBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

	server.tool(
		"minecraft_delegate",
		"マイクラの自分に指示を出す。次のポーリングで反映される。",
		{
			command: z.string().min(1).max(MAX_BRIDGE_MESSAGE_CHARS).describe("マイクラでやること"),
		},
		({ command }) => {
			insertBridgeEvent(db, "to_minecraft", "command", command);
			return {
				content: [{ type: "text" as const, text: "指示を出した。あとでやっとく。" }],
			};
		},
	);

	server.tool("minecraft_status", "マイクラの最新状況を構造化して確認する（消費しない）。", {}, () => {
		const parts: string[] = [];

		const status = getMcConnectionStatus(db);
		const label = status.connected ? "🟢 接続中" : "🔴 未接続";
		parts.push(`接続状態: ${label}${status.since ? ` (${status.since})` : ""}`);

		const events = peekBridgeEvents(db, "to_discord", 50);
		if (events.length > 0) {
			parts.push(formatStatusEvents(events));
		}

		return {
			content: [{ type: "text" as const, text: parts.join("\n\n") }],
		};
	});

	server.tool("minecraft_read_reports", "マイクラでの出来事を確認済みにして読む。", {}, () => {
		const events = consumeBridgeEventsByType(db, "to_discord", "report");
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
			insertBridgeEvent(db, "to_minecraft", "lifecycle", "start");
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
