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
		throw new Error(`ファイルが見つかりません: ${filePath}`);
	}
	const resolved = realpathSync(absolute);
	const allowed = ALLOWED_FILE_DIRS.some((dir) => resolved.startsWith(dir + "/"));
	if (!allowed) {
		throw new Error(`許可されていないファイルパスです: ${filePath}`);
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

const TYPING_INTERVAL_MS = 8_000;
const TYPING_TIMEOUT_MS = 60_000;

interface TypingState {
	interval: ReturnType<typeof setInterval>;
	timeout: ReturnType<typeof setTimeout>;
}

/** Returns a cleanup function that clears all active typing timers */
export function registerDiscordTools(
	server: McpServer,
	deps: DiscordDeps,
	boundGuildId?: string,
): () => void {
	const { discordClient } = deps;
	const typingStates = new Map<string, TypingState>();

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

	function clearTyping(channelId: string) {
		const state = typingStates.get(channelId);
		if (state) {
			clearInterval(state.interval);
			clearTimeout(state.timeout);
			typingStates.delete(channelId);
		}
	}

	function clearAllTyping() {
		for (const [channelId] of typingStates) {
			clearTyping(channelId);
		}
	}

	async function getTextChannel(channelId: string) {
		const channel = await discordClient.channels.fetch(channelId);
		if (!channel?.isTextBased() || !("send" in channel)) {
			throw new Error(`Channel ${channelId} is not a sendable text channel`);
		}
		return channel;
	}

	server.registerTool(
		"send_typing",
		{
			description:
				"Send a typing indicator to a Discord channel. Automatically repeats every 8s until send_message/reply is called, or 60s timeout.",
			inputSchema: { channel_id: z.string() },
		},
		async ({ channel_id }) => {
			const channel = await getTextChannel(channel_id);
			if (!("sendTyping" in channel)) {
				return {
					content: [{ type: "text", text: "Channel does not support typing indicators" }],
				};
			}
			clearTyping(channel_id);
			await channel.sendTyping();
			const interval = setInterval(() => {
				channel.sendTyping().catch(() => clearTyping(channel_id));
			}, TYPING_INTERVAL_MS);
			const timeout = setTimeout(() => clearTyping(channel_id), TYPING_TIMEOUT_MS);
			typingStates.set(channel_id, { interval, timeout });
			return { content: [{ type: "text", text: "Typing indicator started" }] };
		},
	);

	server.registerTool(
		"send_message",
		{
			description: "Send a message to a Discord channel (optionally with a file attachment)",
			inputSchema: {
				channel_id: z.string(),
				content: z.string(),
				file_path: z.string().optional().describe("添付するファイルのパス"),
			},
		},
		async ({ channel_id, content, file_path }) => {
			clearTyping(channel_id);
			deps.skipTracker?.markResponded();
			const channel = await getTextChannel(channel_id);
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
				"Reply to a specific message in a Discord channel (optionally with a file attachment)",
			inputSchema: {
				channel_id: z.string(),
				message_id: z.string(),
				content: z.string(),
				file_path: z.string().optional().describe("添付するファイルのパス"),
			},
		},
		async ({ channel_id, message_id, content, file_path }) => {
			clearTyping(channel_id);
			deps.skipTracker?.markResponded();
			const channel = await getTextChannel(channel_id);
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
				const imageText = imageUrls.length > 0 ? ` [画像: ${imageUrls.join(", ")}]` : "";
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
				return { content: [{ type: "text" as const, text: "エラー: guild_id が必要です" }] };
			}
			const guild = await discordClient.guilds.fetch(gid);
			const channels = await guild.channels.fetch();
			const textChannels = channels
				.filter((c): c is NonNullable<typeof c> => c?.isTextBased() ?? false)
				.map((c) => `${c.name} (${c.id})`);
			return { content: [{ type: "text" as const, text: textChannels.join("\n") }] };
		},
	);

	return clearAllTyping;
}
