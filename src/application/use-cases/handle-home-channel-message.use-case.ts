// oxlint-disable max-dependencies -- DI use case naturally has many port dependencies
import { createChannelSessionKey } from "../../domain/entities/session.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ChannelConfigLoader } from "../../domain/ports/channel-config-loader.port.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { EmojiInfo, EmojiProvider } from "../../domain/ports/emoji-provider.port.ts";
import type { EmojiUsageTracker } from "../../domain/ports/emoji-usage-tracker.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import type { CooldownTracker } from "../../domain/services/cooldown-tracker.ts";
import { filterTopEmojis } from "../../domain/services/emoji-ranking.ts";
import { formatTimestamp } from "../../domain/services/format-timestamp.ts";
import type { MessageBatcher, QueuedMessage } from "../../domain/services/message-batcher.ts";
import { splitMessage } from "../../domain/services/message-formatter.ts";

const TYPING_INTERVAL_MS = 8000;
const JUDGE_CONTEXT_LIMIT = 10;
const TOP_EMOJI_LIMIT = 20;

export class HandleHomeChannelMessageUseCase {
	private flushTimers = new Map<string, Timer>();

	constructor(
		private readonly agent: AiAgent,
		private readonly judge: ResponseJudge,
		private readonly history: ConversationHistory,
		private readonly channelConfig: ChannelConfigLoader,
		private readonly cooldown: CooldownTracker,
		private readonly emojiProvider: EmojiProvider,
		private readonly emojiUsage: EmojiUsageTracker,
		private readonly logger: Logger,
		private readonly batcher: MessageBatcher,
	) {}

	async execute(msg: IncomingMessage, channel: MessageChannel): Promise<void> {
		if (!msg.content && msg.attachments.length === 0) return;

		this.batcher.enqueue(msg.channelId, msg, channel);

		const cooldownSeconds = this.channelConfig.getCooldown(msg.channelId);
		if (this.cooldown.isOnCooldown(msg.channelId, cooldownSeconds)) {
			this.scheduleFlush(msg.channelId, cooldownSeconds);
			return;
		}

		await this.processBatch(msg.channelId);
	}

	private scheduleFlush(channelId: string, cooldownSeconds: number): void {
		if (this.flushTimers.has(channelId)) return;

		const remainingMs = this.cooldown.getRemainingMs(channelId, cooldownSeconds);
		if (remainingMs <= 0) {
			// 境界タイミング: isOnCooldown=true だが残り時間=0 → 即時処理
			this.processBatch(channelId).catch((e) =>
				this.logger.error("Scheduled batch processing failed:", e),
			);
			return;
		}

		const timer = setTimeout(() => {
			this.flushTimers.delete(channelId);
			this.processBatch(channelId).catch((e) =>
				this.logger.error("Scheduled batch processing failed:", e),
			);
		}, remainingMs);
		this.flushTimers.set(channelId, timer);
	}

	private async processBatch(channelId: string): Promise<void> {
		const batch = this.batcher.flush(channelId);
		if (batch.length === 0) return;

		// Optimistic locking: judge 前にクールダウン記録して重複処理を防ぐ
		this.cooldown.record(channelId);

		const latestItem = batch.at(-1);
		if (!latestItem) return;
		const result = await this.judgeMessage(latestItem.msg);
		if (!result) return;

		const { action, emojis } = result;

		if (action.type === "ignore") return;

		if (action.type === "react") {
			await this.handleReact(latestItem.msg, action.emoji, emojis);
			return;
		}

		await this.handleBatchRespond(batch, latestItem.msg, latestItem.channel);
	}

	private async judgeMessage(msg: IncomingMessage) {
		let context;
		try {
			context = await this.history.getRecent(msg.channelId, JUDGE_CONTEXT_LIMIT, msg.messageId);
		} catch (error) {
			this.logger.error("Failed to fetch conversation history:", error);
			return null;
		}

		let allEmojis: EmojiInfo[] | undefined;
		if (msg.guildId) {
			try {
				allEmojis = await this.emojiProvider.getGuildEmojis(msg.guildId);
			} catch (error) {
				this.logger.warn("Failed to fetch guild emojis:", error);
			}
		}

		// 使用頻度データがあればトップ N でフィルタリング
		let judgeEmojis = allEmojis;
		if (allEmojis && msg.guildId && this.emojiUsage.hasData(msg.guildId)) {
			const topUsage = this.emojiUsage.getTopEmojis(msg.guildId, TOP_EMOJI_LIMIT);
			const filtered = filterTopEmojis(allEmojis, topUsage);
			if (filtered.length > 0) {
				judgeEmojis = filtered;
			}
			// filtered が空（データはあるが全て削除済み等）→ allEmojis にフォールバック
		}

		try {
			const decision = await this.judge.judge(
				msg.content,
				context,
				judgeEmojis,
				msg.attachments.length > 0 ? msg.attachments : undefined,
			);
			return { action: decision.action, emojis: allEmojis };
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

	private async handleBatchRespond(
		batch: QueuedMessage[],
		latestMsg: IncomingMessage,
		channel: MessageChannel,
	) {
		const sessionKey = createChannelSessionKey(latestMsg.platform, latestMsg.channelId);

		// バッチ全体のメッセージを結合してプロンプト生成
		const prompt = batch
			.map(
				(item) =>
					`[${formatTimestamp(item.msg.timestamp)}] ${item.msg.authorName}: ${item.msg.content}`,
			)
			.join("\n");

		await channel.sendTyping();
		const typingInterval = setInterval(() => void channel.sendTyping(), TYPING_INTERVAL_MS);

		try {
			const response = await this.agent.send({
				sessionKey,
				message: prompt,
				guildId: latestMsg.guildId,
				attachments: latestMsg.attachments.length > 0 ? latestMsg.attachments : undefined,
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
