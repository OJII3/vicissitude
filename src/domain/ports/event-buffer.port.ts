export interface BufferedEvent {
	ts: string;
	channelId: string;
	guildId?: string;
	authorId: string;
	authorName: string;
	messageId: string;
	content: string;
	isMentioned: boolean;
	isThread: boolean;
}

export interface EventBuffer {
	append(event: BufferedEvent): Promise<void>;
}
