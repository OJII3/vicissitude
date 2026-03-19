import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MINECRAFT_AGENT_ID } from "@vicissitude/shared/constants";
import type { StoreDb } from "@vicissitude/store/db";
import {
	getMcConnectionStatus,
	releaseSessionLock,
	tryAcquireSessionLock,
} from "@vicissitude/store/mc-bridge";
import { appendEvent } from "@vicissitude/store/queries";
import { z } from "zod";

export interface McBridgeDeps {
	db: StoreDb;
}

const MAX_COMMAND_CHARS = 10_000;

/** Discord 側のブリッジツールを登録する */
export function registerDiscordBridgeTools(server: McpServer, deps: McBridgeDeps): void {
	const { db } = deps;

	server.registerTool(
		"minecraft_delegate",
		{
			description: "マイクラの自分に指示を出す。次のポーリングで反映される。",
			inputSchema: {
				command: z.string().min(1).max(MAX_COMMAND_CHARS).describe("マイクラでやること"),
			},
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

	server.registerTool("minecraft_status", { description: "マイクラの最新状況を確認する。" }, () => {
		const status = getMcConnectionStatus(db);
		const label = status.connected ? "接続中" : "未接続";
		const text = `接続状態: ${label}${status.since ? ` (${status.since})` : ""}`;

		return {
			content: [{ type: "text" as const, text }],
		};
	});

	server.registerTool(
		"minecraft_start_session",
		{
			description: "マイクラのセッションを開始する。マイクラが停止中のときに使う。",
			inputSchema: {
				guild_id: z.string().min(1).describe("呼び出し元の guild ID"),
			},
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

	server.registerTool(
		"minecraft_stop_session",
		{
			description: "マイクラのセッションを停止する。",
			inputSchema: {
				guild_id: z.string().min(1).describe("呼び出し元の guild ID"),
			},
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
