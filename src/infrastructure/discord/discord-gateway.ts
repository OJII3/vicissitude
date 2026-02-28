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

	constructor(
		private readonly token: string,
		private readonly logger: Logger,
	) {}

	onMessage(handler: MessageHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		const client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
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

			if ((isMentioned || isThread) && this.handler) {
				await this.handler(this.adaptMessage(message), this.adaptChannel(message));
			}
		});

		await client.login(this.token);
		this.client = client;
	}

	stop(): void {
		this.client?.destroy();
		this.client = null;
	}

	private adaptMessage(message: Message): IncomingMessage {
		return {
			platform: "discord",
			channelId: message.channel.id,
			authorId: message.author.id,
			content: message.content.replaceAll(/<@!?\d+>/g, "").trim(),
			reply: async (text: string) => {
				await message.reply(text);
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
