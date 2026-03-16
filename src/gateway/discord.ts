import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

import type { IncomingMessage, Logger, MessageChannel } from "../core/types.ts";
import { mapAttachments } from "../infrastructure/discord/attachment-mapper.ts";
import { rewriteTwitterUrls } from "../infrastructure/discord/url-rewriter.ts";

type MessageHandler = (msg: IncomingMessage, ch: MessageChannel) => Promise<void>;
type EmojiUsedHandler = (guildId: string, emojiName: string) => void;

/** カスタム絵文字パターン: <:name:id> or <a:name:id> */
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

export class DiscordGateway {
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
		if (this.client) {
			this.logger.warn("[discord] start() called while already running, ignoring");
			return;
		}
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

	private isHomeMessage(message: Message): boolean {
		if (this.homeChannelIds.has(message.channel.id)) return true;
		return (
			message.channel.isThread() &&
			message.channel.parentId !== null &&
			this.homeChannelIds.has(message.channel.parentId)
		);
	}

	private registerMessageHandler(client: Client): void {
		client.on(Events.MessageCreate, async (message) => {
			try {
				if (!client.user) return;

				// bot 自身のメッセージ: ホームチャンネルなら LTM 記録用にハンドラへ流す
				if (message.author.id === client.user.id) {
					if (this.isHomeMessage(message) && this.homeChannelHandler) {
						const adapted = this.adaptMessage(message, false, message.channel.isThread());
						await this.homeChannelHandler(adapted, this.adaptChannel(message));
					}
					return;
				}

				this.trackEmojiUsage(message);

				const isMentioned = message.mentions.has(client.user);
				const adapted = this.adaptMessage(message, isMentioned, message.channel.isThread());
				const channel = this.adaptChannel(message);

				if (this.isHomeMessage(message)) {
					if (this.homeChannelHandler) await this.homeChannelHandler(adapted, channel);
					return;
				}

				if (isMentioned && this.handler) await this.handler(adapted, channel);
			} catch (err) {
				this.logger.error("[discord] messageCreate handler error:", err);
			}
		});
	}

	private trackEmojiUsage(message: Message): void {
		if (!message.guildId || !this.emojiUsedHandler) return;
		for (const match of message.content.matchAll(CUSTOM_EMOJI_RE)) {
			const name = match[1];
			if (name) this.emojiUsedHandler(message.guildId, name);
		}
	}

	private registerReactionHandler(client: Client): void {
		client.on(Events.MessageReactionAdd, (reaction, user) => {
			try {
				if (user.bot) return;
				// Unicode 絵文字は無視
				if (!reaction.emoji.id) return;
				const guildId = reaction.message.guildId;
				if (!guildId || !reaction.emoji.name) return;
				this.emojiUsedHandler?.(guildId, reaction.emoji.name);
			} catch (err) {
				this.logger.error("[discord] reactionAdd handler error:", err);
			}
		});
	}

	private adaptMessage(message: Message, isMentioned: boolean, isThread: boolean): IncomingMessage {
		const attachments = mapAttachments(message.attachments);

		return {
			platform: "discord",
			channelId: message.channel.id,
			guildId: message.guildId ?? undefined,
			authorId: message.author.id,
			authorName:
				message.member?.displayName ?? message.author.displayName ?? message.author.username,
			messageId: message.id,
			content: rewriteTwitterUrls(message.content.replaceAll(/<@!?\d+>/g, "").trim()),
			attachments,
			timestamp: message.createdAt,
			isBot: message.author.bot ?? false,
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
