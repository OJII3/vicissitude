import type { ConversationContext } from "../entities/conversation-context.ts";
import type { EmojiInfo } from "../entities/emoji-info.ts";
import type { ResponseDecision } from "../entities/response-decision.ts";

export interface ResponseJudge {
	judge(
		message: string,
		context: ConversationContext,
		availableEmojis?: EmojiInfo[],
	): Promise<ResponseDecision>;
}
