import type { AgentResponse } from "../entities/agent-response.ts";
import type { Attachment } from "../entities/attachment.ts";

export interface SendOptions {
	sessionKey: string;
	message: string;
	guildId?: string;
	attachments?: Attachment[];
}

export interface AiAgent {
	send(options: SendOptions): Promise<AgentResponse>;
	stop(): void;
}
