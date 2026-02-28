export interface IncomingMessage {
	channelId: string;
	authorId: string;
	content: string;
	reply(text: string): Promise<void>;
}

export interface MessageChannel {
	sendTyping(): Promise<void>;
	send(content: string): Promise<void>;
}

export interface MessageGateway {
	onMessage(handler: (msg: IncomingMessage, ch: MessageChannel) => Promise<void>): void;
	start(): Promise<void>;
	stop(): void;
}
