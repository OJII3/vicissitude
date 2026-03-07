export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationMessage {
	role: ConversationRole;
	content: string;
	timestamp?: Date;
}

export interface ConversationRecorder {
	record(guildId: string, message: ConversationMessage): Promise<void>;
}
