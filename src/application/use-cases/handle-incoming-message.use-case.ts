import { createSessionKey } from "../../domain/entities/session.ts";
import type { AiAgent } from "../../domain/ports/ai-agent.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage, MessageChannel } from "../../domain/ports/message-gateway.port.ts";
import { formatTimestamp } from "../../domain/services/format-timestamp.ts";
import { splitMessage } from "../../domain/services/message-formatter.ts";

const TYPING_INTERVAL_MS = 8000;

export class HandleIncomingMessageUseCase {
	constructor(
		private readonly agent: AiAgent,
		private readonly logger: Logger,
	) {}

	async execute(msg: IncomingMessage, channel: MessageChannel): Promise<void> {
		if (!msg.content && msg.attachments.length === 0) return;

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
			// eslint-disable-next-line no-await-in-loop -- sequential sending is intentional
			for (const chunk of rest) await channel.send(chunk);
		} catch (error) {
			clearInterval(typingInterval);
			this.logger.error("Agent error:", error);
			await msg.reply("エラーが発生しました。しばらく経ってからもう一度お試しください。");
		}
	}
}
