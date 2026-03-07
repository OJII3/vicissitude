import type { Attachment } from "../entities/attachment.ts";

export interface IncomingMessage {
	platform: string;
	channelId: string;
	guildId?: string;
	authorId: string;
	authorName: string;
	messageId: string;
	content: string;
	attachments: Attachment[];
	timestamp: Date;
	isBot: boolean;
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
	onAnyMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
	start(): Promise<void>;
	stop(): void;
}
