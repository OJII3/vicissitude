import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MINECRAFT_AGENT_ID } from "@vicissitude/minecraft/constants";
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
export function registerDiscordBridgeTools(
	server: McpServer,
	deps: McBridgeDeps,
	boundGuildId?: string,
): void {
	const { db } = deps;

	server.registerTool(
		"minecraft_delegate",
		{
			description: "Delegate a command to the Minecraft agent. Reflected on next poll.",
			inputSchema: {
				command: z
					.string()
					.min(1)
					.max(MAX_COMMAND_CHARS)
					.describe("Command for the Minecraft agent"),
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

	server.registerTool(
		"minecraft_status",
		{ description: "Check the latest Minecraft connection status." },
		() => {
			const status = getMcConnectionStatus(db);
			const label = status.connected ? "connected" : "disconnected";
			const text = `Connection status: ${label}${status.since ? ` (${status.since})` : ""}`;

			return {
				content: [{ type: "text" as const, text }],
			};
		},
	);

	server.registerTool(
		"minecraft_start_session",
		{
			description: "Start a Minecraft session. Use when Minecraft is stopped.",
			inputSchema: boundGuildId
				? {}
				: { guild_id: z.string().min(1).describe("Caller's guild ID") },
		},
		({ guild_id }: { guild_id?: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const lock = tryAcquireSessionLock(db, gid);
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
			description: "Stop the Minecraft session.",
			inputSchema: boundGuildId
				? {}
				: { guild_id: z.string().min(1).describe("Caller's guild ID") },
		},
		({ guild_id }: { guild_id?: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const released = releaseSessionLock(db, gid);
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
