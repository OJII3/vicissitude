import { mapAttachments } from "@vicissitude/infrastructure/discord/attachment-mapper";
import { rewriteTwitterUrls } from "@vicissitude/infrastructure/discord/url-rewriter";
import { discordDmScopeId, discordScopeId } from "@vicissitude/shared/namespace";
import type { IncomingMessage, Logger, MessageChannel } from "@vicissitude/shared/types";
import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";

type MessageHandler = (msg: IncomingMessage, ch: MessageChannel) => Promise<void>;
type EmojiUsedHandler = (guildId: string, emojiName: string) => void;

/** カスタム絵文字パターン: <:name:id> or <a:name:id> */
const CUSTOM_EMOJI_RE = /<a?:(\w+):\d+>/g;

export class DiscordGateway {
	private client: Client | null = null;
	private handler: MessageHandler | null = null;
	private homeChannelHandler: MessageHandler | null = null;
	private directMessageHandler: MessageHandler | null = null;
	private homeChannelIds: Set<string> = new Set();
	private allowedDirectMessageUserIds: Set<string> = new Set();
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

	onDirectMessage(handler: MessageHandler): void {
		this.directMessageHandler = handler;
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

	setAllowedDirectMessageUserIds(ids: string[]): void {
		this.allowedDirectMessageUserIds = new Set(ids);
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
			this.logger.info(`[discord] Logged in as ${readyClient.user.tag}`);
		});

		this.registerMessageHandler(client);
		this.registerReactionHandler(client);
		this.registerThreadUpdateHandler(client);

		this.logger.info(
			`[discord] connecting... (homeChannels=${this.homeChannelIds.size}, dmUsers=${this.allowedDirectMessageUserIds.size}, handler=${!!this.handler}, homeHandler=${!!this.homeChannelHandler}, dmHandler=${!!this.directMessageHandler})`,
		);
		await client.login(this.token);
		this.client = client;

		this.joinHomeThreads(client);
	}

	stop(): void {
		void this.client?.destroy();
		this.client = null;
	}

	clearActivity(): void {
		const user = this.client?.user;
		if (!user) return;
		user.setActivity();
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
		// oxlint-disable-next-line typescript/no-misused-promises -- discord.js は void コールバックを期待するが、内部で try-catch 済み
		client.on(Events.MessageCreate, async (message) => {
			try {
				if (!client.user) {
					this.logger.warn("[discord] messageCreate: client.user is null, dropping message");
					return;
				}

				const dmPeerId = this.resolveDirectMessagePeerId(message, client.user.id);

				// bot 自身のメッセージ: ホームチャンネル/許可済み DM なら Memory 記録用にハンドラへ流す
				if (message.author.id === client.user.id) {
					if (this.isHomeMessage(message) && this.homeChannelHandler) {
						const adapted = this.adaptMessage(message, false, message.channel.isThread());
						await this.homeChannelHandler(adapted, this.adaptChannel(message));
					}
					if (
						dmPeerId &&
						this.allowedDirectMessageUserIds.has(dmPeerId) &&
						this.directMessageHandler
					) {
						const adapted = this.adaptMessage(message, false, false, {
							scopeId: discordDmScopeId(dmPeerId),
							channelName: "DM",
						});
						await this.directMessageHandler(adapted, this.adaptChannel(message));
					}
					return;
				}

				this.trackEmojiUsage(message);

				if (dmPeerId) {
					const allowed = this.allowedDirectMessageUserIds.has(dmPeerId);
					this.logger[allowed ? "info" : "warn"](
						`[discord] messageCreate: author=${message.author.username} dmUser=${dmPeerId} allowed=${allowed}`,
					);
					if (!allowed) return;

					const adapted = this.adaptMessage(message, true, false, {
						scopeId: discordDmScopeId(dmPeerId),
						channelName: "DM",
					});
					if (this.directMessageHandler) {
						await this.directMessageHandler(adapted, this.adaptChannel(message));
					}
					return;
				}

				const isMentioned = message.mentions.has(client.user);
				const isHome = this.isHomeMessage(message);

				const logLevel = isHome || isMentioned ? "info" : "debug";
				this.logger[logLevel](
					`[discord] messageCreate: author=${message.author.username} ch=${message.channel.id} guild=${message.guildId ?? "none"} home=${isHome} mentioned=${isMentioned}`,
				);

				const adapted = this.adaptMessage(message, isMentioned, message.channel.isThread());
				const channel = this.adaptChannel(message);

				if (isHome) {
					if (this.homeChannelHandler) await this.homeChannelHandler(adapted, channel);
					return;
				}

				if (isMentioned && this.handler) {
					await this.handler(adapted, channel);
				} else if (!isMentioned) {
					this.logger.debug("[discord] messageCreate: not mentioned and not home, ignoring");
				}
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

	private resolveDirectMessagePeerId(message: Message, clientUserId: string): string | null {
		if (message.guildId) return null;
		if (message.author.id !== clientUserId) return message.author.id;

		const channel = message.channel as {
			recipientId?: string | null;
			recipient?: { id?: string } | null;
			recipients?: Iterable<{ id?: string }>;
		};
		if (channel.recipientId) return channel.recipientId;
		if (channel.recipient?.id) return channel.recipient.id;
		if (channel.recipients) {
			for (const recipient of channel.recipients) {
				if (recipient.id && recipient.id !== clientUserId) return recipient.id;
			}
		}
		return null;
	}

	private registerThreadUpdateHandler(client: Client): void {
		client.on(Events.ThreadUpdate, (_oldThread, newThread) => {
			if (!this.homeChannelIds.has(newThread.id)) return;
			if (!newThread.archived) return;
			newThread.setArchived(false).catch((err) => {
				this.logger.warn("[discord] failed to unarchive home thread:", err);
			});
		});
	}

	private joinHomeThreads(client: Client): void {
		for (const id of this.homeChannelIds) {
			void this.joinIfThread(client, id);
		}
	}

	private async joinIfThread(client: Client, id: string): Promise<void> {
		try {
			const channel = await client.channels.fetch(id);
			if (
				channel &&
				"isThread" in channel &&
				typeof channel.isThread === "function" &&
				channel.isThread()
			) {
				await (channel as { join: () => Promise<unknown> }).join();
			}
		} catch (err) {
			this.logger.warn(`[discord] failed to join home thread ${id}:`, err);
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

	private adaptMessage(
		message: Message,
		isMentioned: boolean,
		isThread: boolean,
		options: { scopeId?: string; channelName?: string } = {},
	): IncomingMessage {
		const attachments = mapAttachments(message.attachments);
		const scopeId =
			options.scopeId ?? (message.guildId ? discordScopeId(message.guildId) : undefined);

		return {
			platform: "discord",
			channelId: message.channel.id,
			channelName:
				options.channelName ??
				("name" in message.channel ? (message.channel.name ?? undefined) : undefined),
			guildId: message.guildId ?? undefined,
			scopeId,
			authorId: message.author.id,
			authorName:
				message.member?.displayName ?? message.author.displayName ?? message.author.username,
			messageId: message.id,
			content: rewriteTwitterUrls(
				message.content
					.replaceAll(/<@!?(\d+)>/g, (_match, id: string) => {
						const member = message.mentions.members?.get(id);
						if (member) return `@${member.displayName}`;
						const user = message.mentions.users.get(id);
						if (user) return `@${user.displayName}`;
						return _match;
					})
					.trim(),
			),
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
