import type { ConversationContext } from "../entities/conversation-context.ts";
import type { ResponseDecision } from "../entities/response-decision.ts";

export interface ResponseJudge {
	judge(message: string, context: ConversationContext): Promise<ResponseDecision>;
}
