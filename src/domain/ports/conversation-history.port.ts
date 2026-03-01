import type { ConversationContext } from "../entities/conversation-context.ts";

export interface ConversationHistory {
	getRecent(channelId: string, limit: number): Promise<ConversationContext>;
}
