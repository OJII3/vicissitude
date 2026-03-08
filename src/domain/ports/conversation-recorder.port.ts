export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationMessage {
	role: ConversationRole;
	content: string;
	/** Display name of the speaker */
	name?: string;
	timestamp?: Date;
}

export interface ConversationRecorder {
	record(guildId: string, message: ConversationMessage): Promise<void>;
}
