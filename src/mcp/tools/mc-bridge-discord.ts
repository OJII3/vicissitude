import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MINECRAFT_AGENT_ID } from "../../core/constants.ts";
import type { StoreDb } from "../../store/db.ts";
import {
	getMcConnectionStatus,
	releaseSessionLock,
	tryAcquireSessionLock,
} from "../../store/mc-bridge.ts";
import { appendEvent } from "../../store/queries.ts";

export interface McBridgeDeps {
	db: StoreDb;
}

const MAX_COMMAND_CHARS = 10_000;

/** Discord 側のブリッジツールを登録する */
export function registerDiscordBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

	server.tool(
		"minecraft_delegate",
		"マイクラの自分に指示を出す。次のポーリングで反映される。",
		{
			command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("マイクラでやること"),
		},
		({ command }) => {
			const event = {
				ts: new Date().toISOString(),
				content: command,
				authorId: "discord",
				authorName: "Discord Agent",
				messageId: `delegate-${Date.now()}`,
				metadata: { type: "command" },
			};
			appendEvent(db, MINECRAFT_AGENT_ID, JSON.stringify(event));
			return {
				content: [{ type: "text" as const, text: "指示を出した。あとでやっとく。" }],
			};
		},
	);

	server.tool("minecraft_status", "マイクラの最新状況を確認する。", {}, () => {
		const status = getMcConnectionStatus(db);
		const label = status.connected ? "接続中" : "未接続";
		const text = `接続状態: ${label}${status.since ? ` (${status.since})` : ""}`;

		return {
			content: [{ type: "text" as const, text }],
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
			const released = releaseSessionLock(db, guild_id);
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
