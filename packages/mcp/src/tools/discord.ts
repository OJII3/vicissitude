import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterImageUrls } from "@vicissitude/infrastructure/discord/attachment-mapper";
import type { EmotionAnalyzer, MoodWriter } from "@vicissitude/shared/ports";
import type { Client } from "discord.js";
import { z } from "zod";

import type { SkipTracker } from "./event-buffer.ts";

const ALLOWED_FILE_DIRS = ["/tmp/vicissitude-screenshots"];

function validateFilePath(filePath: string): void {
	const absolute = path.resolve(filePath);
	if (!existsSync(absolute)) {
		throw new Error(`File not found: ${filePath}`);
	}
	const resolved = realpathSync(absolute);
	const allowed = ALLOWED_FILE_DIRS.some((dir) => resolved.startsWith(dir + "/"));
	if (!allowed) {
		throw new Error(`File path not allowed: ${filePath}`);
	}
}

export interface DiscordDeps {
	discordClient: Client;
	emotionAnalyzer?: EmotionAnalyzer;
	moodWriter?: MoodWriter;
	agentId?: string;
	moodKey?: string;
	skipTracker?: SkipTracker;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** 文字数に応じた typing 遅延（2〜5秒） */
function typingDelay(contentLength: number): number {
	return Math.min(5000, Math.max(2000, contentLength * 20));
}

/** Returns a cleanup function */
export function registerDiscordTools(
	server: McpServer,
	deps: DiscordDeps,
	boundGuildId?: string,
): () => void {
	const { discordClient } = deps;

	/** エージェント応答テキストから感情推定 → MoodStore 書き込み（fire-and-forget） */
	function triggerEmotionEstimation(text: string): void {
		const { emotionAnalyzer, moodWriter, agentId } = deps;
		if (!emotionAnalyzer || !moodWriter || !agentId) return;
		const moodKey = deps.moodKey ?? agentId;
		void (async () => {
			const result = await emotionAnalyzer.analyze({ text });
			if (result.confidence > 0) {
				moodWriter.setMood(moodKey, result.emotion);
			}
		})().catch(() => {});
	}

	async function getTextChannel(channelId: string) {
		const channel = await discordClient.channels.fetch(channelId);
		if (!channel?.isTextBased() || !("send" in channel)) {
			throw new Error(`Channel ${channelId} is not a sendable text channel`);
		}
		return channel;
	}

	server.registerTool(
		"send_message",
		{
			description:
				"Send a message to a Discord channel (optionally with a file attachment). Automatically shows typing indicator before sending.",
			inputSchema: {
				channel_id: z.string(),
				content: z.string(),
				file_path: z.string().optional().describe("Path to a file to attach"),
			},
		},
		async ({ channel_id, content, file_path }) => {
			deps.skipTracker?.markResponded();
			const channel = await getTextChannel(channel_id);
			if ("sendTyping" in channel) {
				await channel.sendTyping();
			}
			await sleep(typingDelay(content.length));
			const options: { content: string; files?: { attachment: string }[] } = { content };
			if (file_path) {
				validateFilePath(file_path);
				options.files = [{ attachment: file_path }];
			}
			const msg = await channel.send(options);
			triggerEmotionEstimation(content);
			return { content: [{ type: "text", text: `Sent message ${msg.id}` }] };
		},
	);

	server.registerTool(
		"reply",
		{
			description:
				"Reply to a specific message in a Discord channel (optionally with a file attachment). Automatically shows typing indicator before sending.",
			inputSchema: {
				channel_id: z.string(),
				message_id: z.string(),
				content: z.string(),
				file_path: z.string().optional().describe("Path to a file to attach"),
			},
		},
		async ({ channel_id, message_id, content, file_path }) => {
			deps.skipTracker?.markResponded();
			const channel = await getTextChannel(channel_id);
			if ("sendTyping" in channel) {
				await channel.sendTyping();
			}
			await sleep(typingDelay(content.length));
			const target = await channel.messages.fetch(message_id);
			const options: { content: string; files?: { attachment: string }[] } = { content };
			if (file_path) {
				validateFilePath(file_path);
				options.files = [{ attachment: file_path }];
			}
			const msg = await target.reply(options);
			triggerEmotionEstimation(content);
			return { content: [{ type: "text", text: `Replied with message ${msg.id}` }] };
		},
	);

	server.registerTool(
		"add_reaction",
		{
			description: "Add a reaction emoji to a message",
			inputSchema: { channel_id: z.string(), message_id: z.string(), emoji: z.string() },
		},
		async ({ channel_id, message_id, emoji }) => {
			deps.skipTracker?.markResponded();
			const channel = await getTextChannel(channel_id);
			const target = await channel.messages.fetch(message_id);
			await target.react(emoji);
			return { content: [{ type: "text", text: `Reacted with ${emoji}` }] };
		},
	);

	server.registerTool(
		"read_messages",
		{
			description: "Read recent messages from a Discord channel",
			inputSchema: { channel_id: z.string(), limit: z.number().min(1).max(50).default(10) },
		},
		async ({ channel_id, limit }) => {
			const channel = await getTextChannel(channel_id);
			const messages = await channel.messages.fetch({ limit });
			const formatted = messages.map((m) => {
				const imageUrls = filterImageUrls(m.attachments);
				const imageText = imageUrls.length > 0 ? ` [images: ${imageUrls.join(", ")}]` : "";
				return `[${m.author.tag}] ${m.content}${imageText}`;
			});
			return { content: [{ type: "text", text: formatted.join("\n") }] };
		},
	);

	server.registerTool(
		"list_channels",
		{
			description: "List text channels in a Discord guild",
			inputSchema: boundGuildId ? {} : { guild_id: z.string() },
		},
		async ({ guild_id }: { guild_id?: string }) => {
			const gid = boundGuildId ?? guild_id;
			if (!gid) {
				return { content: [{ type: "text" as const, text: "Error: guild_id is required" }] };
			}
			const guild = await discordClient.guilds.fetch(gid);
			const channels = await guild.channels.fetch();
			const textChannels = channels
				.filter((c): c is NonNullable<typeof c> => c?.isTextBased() ?? false)
				.map((c) => `${c.name} (${c.id})`);
			return { content: [{ type: "text" as const, text: textChannels.join("\n") }] };
		},
	);

	return () => {};
}
