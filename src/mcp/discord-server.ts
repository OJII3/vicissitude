import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, GatewayIntentBits } from "discord.js";
import { z } from "zod";

const discordClient = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

await discordClient.login(process.env.DISCORD_TOKEN);

const server = new McpServer({
	name: "discord",
	version: "0.1.0",
});

const TYPING_INTERVAL_MS = 8_000;
const TYPING_TIMEOUT_MS = 60_000;

interface TypingState {
	interval: ReturnType<typeof setInterval>;
	timeout: ReturnType<typeof setTimeout>;
}

const typingStates = new Map<string, TypingState>();

function clearTyping(channelId: string) {
	const state = typingStates.get(channelId);
	if (state) {
		clearInterval(state.interval);
		clearTimeout(state.timeout);
		typingStates.delete(channelId);
	}
}

async function getTextChannel(channelId: string) {
	const channel = await discordClient.channels.fetch(channelId);
	if (!channel?.isTextBased() || !("send" in channel)) {
		throw new Error(`Channel ${channelId} is not a sendable text channel`);
	}
	return channel;
}

server.tool(
	"send_typing",
	"Send a typing indicator to a Discord channel. Automatically repeats every 8s until send_message/reply is called, or 60s timeout.",
	{ channel_id: z.string() },
	async ({ channel_id }) => {
		const channel = await getTextChannel(channel_id);
		if (!("sendTyping" in channel)) {
			return { content: [{ type: "text", text: "Channel does not support typing indicators" }] };
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

server.tool(
	"send_message",
	"Send a message to a Discord channel",
	{ channel_id: z.string(), content: z.string() },
	async ({ channel_id, content }) => {
		clearTyping(channel_id);
		const channel = await getTextChannel(channel_id);
		const msg = await channel.send(content);
		return { content: [{ type: "text", text: `Sent message ${msg.id}` }] };
	},
);

server.tool(
	"reply",
	"Reply to a specific message in a Discord channel",
	{ channel_id: z.string(), message_id: z.string(), content: z.string() },
	async ({ channel_id, message_id, content }) => {
		clearTyping(channel_id);
		const channel = await getTextChannel(channel_id);
		const target = await channel.messages.fetch(message_id);
		const msg = await target.reply(content);
		return { content: [{ type: "text", text: `Replied with message ${msg.id}` }] };
	},
);

server.tool(
	"add_reaction",
	"Add a reaction emoji to a message",
	{ channel_id: z.string(), message_id: z.string(), emoji: z.string() },
	async ({ channel_id, message_id, emoji }) => {
		const channel = await getTextChannel(channel_id);
		const target = await channel.messages.fetch(message_id);
		await target.react(emoji);
		return { content: [{ type: "text", text: `Reacted with ${emoji}` }] };
	},
);

server.tool(
	"read_messages",
	"Read recent messages from a Discord channel",
	{ channel_id: z.string(), limit: z.number().min(1).max(50).default(10) },
	async ({ channel_id, limit }) => {
		const channel = await getTextChannel(channel_id);
		const messages = await channel.messages.fetch({ limit });
		const formatted = messages.map((m) => {
			const imageUrls = m.attachments
				.filter((a) => a.contentType?.startsWith("image/"))
				.map((a) => a.url);
			const imageText = imageUrls.length > 0 ? ` [画像: ${imageUrls.join(", ")}]` : "";
			return `[${m.author.tag}] ${m.content}${imageText}`;
		});
		return { content: [{ type: "text", text: formatted.join("\n") }] };
	},
);

server.tool(
	"list_channels",
	"List text channels in a Discord guild",
	{ guild_id: z.string() },
	async ({ guild_id }) => {
		const guild = await discordClient.guilds.fetch(guild_id);
		const channels = await guild.channels.fetch();
		const textChannels = channels
			.filter((c): c is NonNullable<typeof c> => c?.isTextBased() ?? false)
			.map((c) => `${c.name} (${c.id})`);
		return { content: [{ type: "text", text: textChannels.join("\n") }] };
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
