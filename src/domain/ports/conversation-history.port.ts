import type { ConversationContext } from "../entities/conversation-context.ts";

export interface ConversationHistory {
	getRecent(
		channelId: string,
		limit: number,
		excludeMessageId?: string,
	): Promise<ConversationContext>;
}
