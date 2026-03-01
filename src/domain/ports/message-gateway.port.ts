export interface IncomingMessage {
	platform: string;
	channelId: string;
	authorId: string;
	authorName: string;
	messageId: string;
	content: string;
	isMentioned: boolean;
	isThread: boolean;
	reply(text: string): Promise<void>;
	react(emoji: string): Promise<void>;
}

export interface MessageChannel {
	sendTyping(): Promise<void>;
	send(content: string): Promise<void>;
}

type MessageHandler = (msg: IncomingMessage, ch: MessageChannel) => Promise<void>;

export interface MessageGateway {
	onMessage(handler: MessageHandler): void;
	onHomeChannelMessage(handler: MessageHandler): void;
	start(): Promise<void>;
	stop(): void;
}
