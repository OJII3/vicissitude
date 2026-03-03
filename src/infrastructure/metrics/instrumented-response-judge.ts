import type { Attachment } from "../../domain/entities/attachment.ts";
import type { ConversationContext } from "../../domain/entities/conversation-context.ts";
import type { EmojiInfo } from "../../domain/entities/emoji-info.ts";
import type { ResponseDecision } from "../../domain/entities/response-decision.ts";
import type { MetricsCollector } from "../../domain/ports/metrics-collector.port.ts";
import type { ResponseJudge } from "../../domain/ports/response-judge.port.ts";
import { METRIC } from "./metric-names.ts";

export class InstrumentedResponseJudge implements ResponseJudge {
	constructor(
		private readonly inner: ResponseJudge,
		private readonly metrics: MetricsCollector,
	) {}

	async judge(
		message: string,
		context: ConversationContext,
		availableEmojis?: EmojiInfo[],
		attachments?: Attachment[],
	): Promise<ResponseDecision> {
		try {
			const decision = await this.inner.judge(message, context, availableEmojis, attachments);
			this.metrics.incrementCounter(METRIC.JUDGE_REQUESTS, { action: decision.action.type });
			return decision;
		} catch (error) {
			this.metrics.incrementCounter(METRIC.JUDGE_REQUESTS, { action: "error" });
			throw error;
		}
	}
}
