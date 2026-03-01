import { Client, Events, GatewayIntentBits, type Message } from "discord.js";

import type { Logger } from "../../domain/ports/logger.port.ts";
import type {
	IncomingMessage,
	MessageChannel,
	MessageGateway,
} from "../../domain/ports/message-gateway.port.ts";

type MessageHandler = (msg: IncomingMessage, ch: MessageChannel) => Promise<void>;

export class DiscordGateway implements MessageGateway {
	private client: Client | null = null;
	private handler: MessageHandler | null = null;
	private homeChannelHandler: MessageHandler | null = null;
	private homeChannelIds: Set<string> = new Set();

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
		});

		client.once(Events.ClientReady, (readyClient) => {
			this.logger.info(`Logged in as ${readyClient.user.tag}`);
		});

		client.on(Events.MessageCreate, async (message) => {
			if (message.author.bot) return;
			if (!client.user) return;

			const isMentioned = message.mentions.has(client.user);
			const isThread = message.channel.isThread();
			const isHomeChannel = this.homeChannelIds.has(message.channel.id);

			const adapted = this.adaptMessage(message, isMentioned, isThread);
			const channel = this.adaptChannel(message);

			// メンション or スレッド → 従来のハンドラ（必ず応答）
			if ((isMentioned || isThread) && this.handler) {
				await this.handler(adapted, channel);
				return;
			}

			// ホームチャンネル → ホームチャンネルハンドラ（judge で判断）
			if (isHomeChannel && this.homeChannelHandler) {
				await this.homeChannelHandler(adapted, channel);
			}

			// それ以外 → 無視
		});

		await client.login(this.token);
		this.client = client;
	}

	stop(): void {
		this.client?.destroy();
		this.client = null;
	}

	private adaptMessage(message: Message, isMentioned: boolean, isThread: boolean): IncomingMessage {
		return {
			platform: "discord",
			channelId: message.channel.id,
			authorId: message.author.id,
			authorName:
				message.member?.displayName ?? message.author.displayName ?? message.author.username,
			messageId: message.id,
			content: message.content.replaceAll(/<@!?\d+>/g, "").trim(),
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
