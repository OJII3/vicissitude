import { createSessionKey } from "../../domain/entities/session.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { ConversationHistory } from "../../domain/ports/conversation-history.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { formatTimestamp } from "../../domain/services/format-timestamp.ts";
import { splitMessage } from "../../domain/services/message-formatter.ts";

const TYPING_INTERVAL_MS = 8000;
const JUDGE_CONTEXT_LIMIT = 10;

export class HandleIncomingMessageUseCase {
	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
		private readonly judge?: ResponseJudge,
		private readonly history?: ConversationHistory,
	) {}

	async execute(msg: IncomingMessage, channel: MessageChannel): Promise<void> {
		if (!msg.content && msg.attachments.length === 0) return;

		// Botからのメンションはjudgeで応答判断する
		if (msg.isBot && this.judge && this.history) {
			const shouldRespond = await this.judgeBotMention(msg, this.judge, this.history);
			if (!shouldRespond) return;
		}

		const sessionKey = createSessionKey(msg.platform, msg.channelId, msg.authorId);

		await channel.sendTyping();
		const typingInterval = setInterval(() => void channel.sendTyping(), TYPING_INTERVAL_MS);

		try {
			const prompt = `[${formatTimestamp(msg.timestamp)}] ${msg.content}`;
			const response = await this.agent.send({
				sessionKey,
				message: prompt,
				guildId: msg.guildId,
				attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
			});
			clearInterval(typingInterval);

			const chunks = splitMessage(response.text);
			const [first, ...rest] = chunks;
			if (first) await msg.reply(first);
			// oxlint-disable-next-line no-await-in-loop -- sequential sending is intentional
			for (const chunk of rest) await channel.send(chunk);
		} catch (error) {
			clearInterval(typingInterval);
			this.logger.error("Agent error:", error);
			await msg.reply("エラーが発生しました。しばらく経ってからもう一度お試しください。");
		}
	}

	private async judgeBotMention(
		msg: IncomingMessage,
		judge: ResponseJudge,
		history: ConversationHistory,
	): Promise<boolean> {
		try {
			const context = await history.getRecent(msg.channelId, JUDGE_CONTEXT_LIMIT, msg.messageId);
			const judgeContent = `[Bot] ${msg.content}`;
			const decision = await judge.judge(
				judgeContent,
				context,
				undefined,
				msg.attachments.length > 0 ? msg.attachments : undefined,
			);
			if (decision.action.type === "respond") {
				return true;
			}
			this.logger.info(
				`[handle-incoming] Bot mention ignored: action=${decision.action.type} reason=${decision.reason}`,
			);
			return false;
		} catch (error) {
			this.logger.error("Judge failed for bot mention, defaulting to ignore:", error);
			return false;
		}
	}
}
