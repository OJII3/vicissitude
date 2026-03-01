import { createChannelSessionKey } from "../../domain/entities/session.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ChannelConfigLoader } from "../../domain/ports/channel-config-loader.port.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import type { CooldownTracker } from "../../domain/services/cooldown-tracker.ts";
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
		private readonly logger: Logger,
	) {}

	async execute(msg: IncomingMessage, channel: MessageChannel): Promise<void> {
		if (!msg.content) return;

		const cooldownSeconds = this.channelConfig.getCooldown(msg.channelId);
		if (this.cooldown.isOnCooldown(msg.channelId, cooldownSeconds)) return;

		let context;
		try {
			context = await this.history.getRecent(msg.channelId, JUDGE_CONTEXT_LIMIT);
		} catch (error) {
			this.logger.error("Failed to fetch conversation history:", error);
			return;
		}

		let decision;
		try {
			decision = await this.judge.judge(msg.content, context);
		} catch (error) {
			this.logger.error("Judge failed, defaulting to ignore:", error);
			return;
		}

		if (decision.action.type === "ignore") return;

		if (decision.action.type === "react") {
			try {
				await msg.react(decision.action.emoji);
				this.cooldown.record(msg.channelId);
			} catch (error) {
				this.logger.error("Failed to react:", error);
			}
			return;
		}

		// decision.action.type === "respond"
		const sessionKey = createChannelSessionKey(msg.platform, msg.channelId);
		const prompt = `${msg.authorName}: ${msg.content}`;

		await channel.sendTyping();
		const typingInterval = setInterval(() => void channel.sendTyping(), TYPING_INTERVAL_MS);

		try {
			const response = await this.agent.send(sessionKey, prompt);
			clearInterval(typingInterval);

			const chunks = splitMessage(response.text);
			const [first, ...rest] = chunks;
			if (first) await channel.send(first);
			// eslint-disable-next-line no-await-in-loop -- sequential sending is intentional
			for (const chunk of rest) await channel.send(chunk);

			this.cooldown.record(msg.channelId);
		} catch (error) {
			clearInterval(typingInterval);
			this.logger.error("Agent error in home channel:", error);
		}
	}
}
