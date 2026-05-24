import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterImageUrls } from "@vicissitude/infrastructure/discord/attachment-mapper";
import type { EmotionAnalyzer, MoodWriter } from "@vicissitude/shared/ports";
import type { Logger } from "@vicissitude/shared/types";
import { ChannelType, type Client, type TextChannel } from "discord.js";
import { z } from "zod/v4";

const DEFAULT_ALLOWED_FILE_DIRS = ["/tmp/vicissitude-screenshots"];
const ATTACHMENT_ALLOWED_DIRS_ENV = "DISCORD_ATTACHMENT_ALLOWED_DIRS";

function allowedFileDirs(): string[] {
	const extra = (process.env[ATTACHMENT_ALLOWED_DIRS_ENV] ?? "")
		.split(path.delimiter)
		.map((dir) => dir.trim())
		.filter((dir) => dir.length > 0);
	return [...DEFAULT_ALLOWED_FILE_DIRS, ...extra].map((dir) => path.resolve(dir));
}

function validateFilePath(filePath: string): void {
	const absolute = path.resolve(filePath);
	if (!existsSync(absolute)) {
		throw new Error(`File not found: ${filePath}`);
	}
	const resolved = realpathSync(absolute);
	const allowed = allowedFileDirs().some(
		(dir) => resolved === dir || resolved.startsWith(dir + path.sep),
	);
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
	logger?: Logger;
}

export interface DiscordToolBounds {
	guildId?: string;
	dmUserId?: string;
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

function assertBoundDmChannel(channel: unknown, boundDmUserId: string, channelId: string): void {
	const candidate = channel as {
		type?: ChannelType;
		recipientId?: string | null;
		recipient?: { id?: string } | null;
		recipients?: Iterable<{ id?: string }>;
	};
	if (candidate.type !== ChannelType.DM) {
		throw new Error(`Channel ${channelId} is not a DM channel for the bound user`);
	}
	if (candidate.recipientId === boundDmUserId || candidate.recipient?.id === boundDmUserId) {
		return;
	}
	if (candidate.recipients) {
		for (const recipient of candidate.recipients) {
			if (recipient.id === boundDmUserId) return;
		}
	}
	throw new Error(`Channel ${channelId} is not a DM channel for the bound user`);
}

/** Returns a cleanup function */
export function registerDiscordTools(
	server: McpServer,
	deps: DiscordDeps,
	bounds: DiscordToolBounds = {},
): () => void {
	const { discordClient } = deps;
	const { guildId: boundGuildId, dmUserId: boundDmUserId } = bounds;

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
		})().catch((error) => {
			deps.logger?.warn("[discord] emotion estimation failed:", error);
		});
	}

	async function getSendableChannel(channelId: string) {
		// Gateway 経由でキャッシュ済みのスレッドを優先（最も確実）
		let channel =
			discordClient.channels.cache.get(channelId) ??
			(await discordClient.channels.fetch(channelId, { allowUnknownGuild: true }));
		if (!channel || !("send" in channel) || typeof channel.send !== "function") {
			const type = channel?.type;
			throw new Error(`Channel ${channelId} is not sendable (type=${type ?? "null"})`);
		}
		if (boundDmUserId) assertBoundDmChannel(channel, boundDmUserId, channelId);
		return channel as TextChannel;
	}

	server.registerTool(
		"send_message",
		{
			description:
				"Send a message to a Discord channel (optionally with a file attachment). channel_id accepts text channels, DMs, threads, and forum threads.",
			inputSchema: {
				channel_id: z.string(),
				content: z.string(),
				file_path: z.string().optional().describe("Path to a file to attach"),
			},
		},
		async ({
			channel_id,
			content,
			file_path,
		}: {
			channel_id: string;
			content: string;
			file_path?: string;
		}) => {
			const channel = await getSendableChannel(channel_id);
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
		async ({
			channel_id,
			message_id,
			content,
			file_path,
		}: {
			channel_id: string;
			message_id: string;
			content: string;
			file_path?: string;
		}) => {
			const channel = await getSendableChannel(channel_id);
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
		async ({
			channel_id,
			message_id,
			emoji,
		}: {
			channel_id: string;
			message_id: string;
			emoji: string;
		}) => {
			const channel = await getSendableChannel(channel_id);
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
		async ({ channel_id, limit }: { channel_id: string; limit: number }) => {
			const channel = await getSendableChannel(channel_id);
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
			description:
				"List text channels in a Discord guild. Threads and forum threads are NOT included. You usually don't need this — the channel_id is already in the message header.",
			inputSchema: boundGuildId || boundDmUserId ? {} : { guild_id: z.string() },
		},
		async ({ guild_id }: { guild_id?: string }) => {
			if (boundDmUserId) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: list_channels is not available in DM scope",
						},
					],
					isError: true,
				};
			}
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
