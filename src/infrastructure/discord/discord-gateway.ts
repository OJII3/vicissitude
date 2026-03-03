import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

import type { Attachment } from "../../domain/entities/attachment.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type {
	IncomingMessage,
	MessageChannel,
	MessageGateway,
} from "../../domain/ports/message-gateway.port.ts";

type MessageHandler = (msg: IncomingMessage, ch: MessageChannel) => Promise<void>;
type EmojiUsedHandler = (guildId: string, emojiName: string) => void;

/** カスタム絵文字パターン: <:name:id> or <a:name:id> */
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

export class DiscordGateway implements MessageGateway {
	private client: Client | null = null;
	private handler: MessageHandler | null = null;
	private homeChannelHandler: MessageHandler | null = null;
	private homeChannelIds: Set<string> = new Set();
	private emojiUsedHandler: EmojiUsedHandler | null = null;

	constructor(
		private readonly token: string,
		private readonly logger: Logger,
	) {}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
	}

	onHomeChannelMessage(handler: MessageHandler): void {
		this.homeChannelHandler = handler;
	}

	onEmojiUsed(handler: EmojiUsedHandler): void {
		this.emojiUsedHandler = handler;
	}

	/**
	 * ホームチャンネルIDのセットを設定する。
	 * start() の前に呼ぶこと。
	 */
	setHomeChannelIds(ids: string[]): void {
		this.homeChannelIds = new Set(ids);
	}

	getClient(): Client | null {
		return this.client;
	}

	async start(): Promise<void> {
		const client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.GuildMessageReactions,
			],
			partials: [Partials.Reaction, Partials.Message, Partials.Channel],
		});

		client.once(Events.ClientReady, (readyClient) => {
			this.logger.info(`Logged in as ${readyClient.user.tag}`);
		});

		this.registerMessageHandler(client);
		this.registerReactionHandler(client);

		await client.login(this.token);
		this.client = client;
	}

	stop(): void {
		this.client?.destroy();
		this.client = null;
	}

	private registerMessageHandler(client: Client): void {
		client.on(Events.MessageCreate, async (message) => {
			if (message.author.bot) return;
			if (!client.user) return;

			// カスタム絵文字使用を記録
			if (message.guildId && this.emojiUsedHandler) {
				for (const match of message.content.matchAll(CUSTOM_EMOJI_RE)) {
					const name = match[1];
					if (name) this.emojiUsedHandler(message.guildId, name);
				}
			}

			const isMentioned = message.mentions.has(client.user);
			const isThread = message.channel.isThread();
			const isHomeChannel = this.homeChannelIds.has(message.channel.id);
			const isHomeThread =
				message.channel.isThread() &&
				message.channel.parentId !== null &&
				this.homeChannelIds.has(message.channel.parentId);

			const adapted = this.adaptMessage(message, isMentioned, isThread);
			const channel = this.adaptChannel(message);

			// メンション → 必ず応答
			if (isMentioned && this.handler) {
				await this.handler(adapted, channel);
				return;
			}

			// ホームチャンネル or その配下スレッド → judge で判断
			if ((isHomeChannel || isHomeThread) && this.homeChannelHandler) {
				await this.homeChannelHandler(adapted, channel);
			}

			// それ以外（他チャンネルのスレッド含む） → 無視
		});
	}

	private registerReactionHandler(client: Client): void {
		client.on(Events.MessageReactionAdd, (reaction, user) => {
			if (user.bot) return;
			// Unicode 絵文字は無視
			if (!reaction.emoji.id) return;
			const guildId = reaction.message.guildId;
			if (!guildId || !reaction.emoji.name) return;
			this.emojiUsedHandler?.(guildId, reaction.emoji.name);
		});
	}

	private adaptMessage(message: Message, isMentioned: boolean, isThread: boolean): IncomingMessage {
		const attachments: Attachment[] = message.attachments
			.filter((a) => a.contentType?.startsWith("image/"))
			.map((a) => ({
				url: a.url,
				contentType: a.contentType ?? undefined,
				filename: a.name ?? undefined,
			}));

		return {
			platform: "discord",
			channelId: message.channel.id,
			guildId: message.guildId ?? undefined,
			authorId: message.author.id,
			authorName:
				message.member?.displayName ?? message.author.displayName ?? message.author.username,
			messageId: message.id,
			content: message.content.replaceAll(/<@!?\d+>/g, "").trim(),
			attachments,
			timestamp: message.createdAt,
			isMentioned,
			isThread,
			reply: async (text: string) => {
				await message.reply(text);
			},
			react: async (emoji: string) => {
				await message.react(emoji);
			},
		};
	}

	private adaptChannel(message: Message): MessageChannel {
		const channel = message.channel;
		return {
			sendTyping: async () => {
				if ("sendTyping" in channel) {
					await channel.sendTyping();
				}
			},
			send: async (content: string) => {
				if ("send" in channel) {
					await channel.send(content);
				}
			},
		};
	}
}
