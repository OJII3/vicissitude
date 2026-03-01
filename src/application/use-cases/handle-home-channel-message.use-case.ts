// oxlint-disable max-dependencies -- DI use case naturally has many port dependencies
import { createChannelSessionKey } from "../../domain/entities/session.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ChannelConfigLoader } from "../../domain/ports/channel-config-loader.port.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { EmojiInfo, EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import type { CooldownTracker } from "../../domain/services/cooldown-tracker.ts";
import { formatTimestamp } from "../../domain/services/format-timestamp.ts";
import { splitMessage } from "../../domain/services/message-formatter.ts";

const TYPING_INTERVAL_MS = 8000;
const JUDGE_CONTEXT_LIMIT = 10;

export class HandleHomeChannelMessageUseCase {
	constructor(
		private readonly agent: AiAgent,
		private readonly judge: ResponseJudge,
		private readonly history: ConversationHistory,
		private readonly channelConfig: ChannelConfigLoader,
		private readonly cooldown: CooldownTracker,
		private readonly emojiProvider: EmojiProvider,
		private readonly logger: Logger,
	) {}

	async execute(msg: IncomingMessage, channel: MessageChannel): Promise<void> {
		if (!msg.content) return;

		const cooldownSeconds = this.channelConfig.getCooldown(msg.channelId);
		if (this.cooldown.isOnCooldown(msg.channelId, cooldownSeconds)) return;

		// Optimistic locking: judge 前にクールダウン記録して重複処理を防ぐ
		this.cooldown.record(msg.channelId);

		const result = await this.judgeMessage(msg);
		if (!result) return;

		const { action, emojis } = result;

		if (action.type === "ignore") return;

		if (action.type === "react") {
			await this.handleReact(msg, action.emoji, emojis);
			return;
		}

		await this.handleRespond(msg, channel);
	}

	private async judgeMessage(msg: IncomingMessage) {
		let context;
		try {
			context = await this.history.getRecent(msg.channelId, JUDGE_CONTEXT_LIMIT, msg.messageId);
		} catch (error) {
			this.logger.error("Failed to fetch conversation history:", error);
			return null;
		}

		let emojis: EmojiInfo[] | undefined;
		if (msg.guildId) {
			try {
				emojis = await this.emojiProvider.getGuildEmojis(msg.guildId);
			} catch (error) {
				this.logger.warn("Failed to fetch guild emojis:", error);
			}
		}

		try {
			const decision = await this.judge.judge(msg.content, context, emojis);
			return { action: decision.action, emojis };
		} catch (error) {
			this.logger.error("Judge failed, defaulting to ignore:", error);
			return null;
		}
	}

	private async handleReact(msg: IncomingMessage, emoji: string, emojis?: EmojiInfo[]) {
		try {
			const resolved = this.resolveEmoji(emoji, emojis);
			await msg.react(resolved);
		} catch (error) {
			this.logger.error("Failed to react:", error);
		}
	}

	private resolveEmoji(emoji: string, emojis?: EmojiInfo[]): string {
		// :name: 形式のカスタム絵文字を identifier に解決
		const match = /^:(.+):$/.exec(emoji);
		if (!match || !emojis) return emoji;

		const name = match[1];
		const found = emojis.find((e) => e.name === name);
		return found ? found.identifier : emoji;
	}

	private async handleRespond(msg: IncomingMessage, channel: MessageChannel) {
		const sessionKey = createChannelSessionKey(msg.platform, msg.channelId);
		const prompt = `[${formatTimestamp(msg.timestamp)}] ${msg.authorName}: ${msg.content}`;

		await channel.sendTyping();
		const typingInterval = setInterval(() => void channel.sendTyping(), TYPING_INTERVAL_MS);

		try {
			const response = await this.agent.send({
				sessionKey,
				message: prompt,
				guildId: msg.guildId,
			});
			clearInterval(typingInterval);

			const chunks = splitMessage(response.text);
			const [first, ...rest] = chunks;
			if (first) await channel.send(first);
			// oxlint-disable-next-line no-await-in-loop -- sequential sending is intentional
			for (const chunk of rest) await channel.send(chunk);
		} catch (error) {
			clearInterval(typingInterval);
			this.logger.error("Agent error in home channel:", error);
		}
	}
}
