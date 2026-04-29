import { describe, expect, mock, test } from "bun:test";

import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { discordGuildNamespace } from "@vicissitude/memory/namespace";
import type { ConversationRecorder, IncomingMessage } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";

function createMockMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		platform: "discord",
		channelId: "ch-1",
		channelName: "general",
		guildId: "1111",
		authorId: "user-1",
		authorName: "TestUser",
		messageId: "msg-1",
		content: "hello",
		attachments: [],
		timestamp: new Date("2026-03-01T12:00:00Z"),
		isBot: false,
		isMentioned: false,
		isThread: false,
		reply: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		...overrides,
	};
}

describe("MessageIngestionService", () => {
	test("guildId がなければ warn を出して何もしない", () => {
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger });

		service.handleIncomingMessage(createMockMessage({ guildId: undefined }));

		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	test("recorder があれば会話記録を行う", async () => {
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		service.handleIncomingMessage(
			createMockMessage({
				isBot: true,
				content: "ボットの応答",
				attachments: [{ url: "https://example.com/file", filename: "cap.png" }],
			}),
			{ recordConversation: true },
		);

		await Promise.resolve();

		expect(recorder.record).toHaveBeenCalledTimes(1);
		expect(recorder.record).toHaveBeenCalledWith(
			discordGuildNamespace("1111"),
			expect.objectContaining({
				role: "assistant",
				content: "ボットの応答 [添付: cap.png]",
			}),
		);
	});

	test("ConversationMessage に IncomingMessage.authorId が転送される", async () => {
		// CriticAuditor が authorId でフィルタするため、IngestionService は authorId を保持して
		// ConversationRecorder に渡す責務がある（#847）
		const recordMock = mock(() => Promise.resolve());
		const recorder: ConversationRecorder = { record: recordMock };
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		service.handleIncomingMessage(
			createMockMessage({
				isBot: true,
				authorId: "1100000000000000001",
				// guild ニックネーム
				authorName: "hua-bot",
				content: "応答",
			}),
			{ recordConversation: true },
		);

		await Promise.resolve();

		expect(recordMock).toHaveBeenCalledTimes(1);
		expect(recordMock).toHaveBeenCalledWith(
			discordGuildNamespace("1111"),
			expect.objectContaining({
				role: "assistant",
				content: "応答",
				authorId: "1100000000000000001",
				name: "hua-bot",
			}),
		);
	});

	test("recordConversation 未指定なら Memory 記録しない", async () => {
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		service.handleIncomingMessage(createMockMessage({ content: "mention only" }));
		await Promise.resolve();

		expect(recorder.record).not.toHaveBeenCalled();
	});

	test("content も attachments も空ならドロップする", () => {
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger });

		service.handleIncomingMessage(createMockMessage({ content: "", attachments: [] }));

		expect(logger.info).toHaveBeenCalledTimes(1);
	});
});
