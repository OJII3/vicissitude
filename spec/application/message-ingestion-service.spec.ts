import { describe, expect, mock, test } from "bun:test";

import { MessageIngestionService } from "@vicissitude/application/message-ingestion-service";
import { discordGuildNamespace } from "@vicissitude/shared/namespace";
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
	test("guildId がなければ warn を出して dropped を返す", async () => {
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger });

		const result = await service.handleIncomingMessage(createMockMessage({ guildId: undefined }));

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ status: "dropped", reason: "missing_guild_id" });
	});

	test("recorder があれば会話記録を行う", async () => {
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		const result = await service.handleIncomingMessage(
			createMockMessage({
				isBot: true,
				content: "ボットの応答",
				attachments: [{ url: "https://example.com/file", filename: "cap.png" }],
			}),
			{ recordConversation: true },
		);

		expect(recorder.record).toHaveBeenCalledTimes(1);
		expect(recorder.record).toHaveBeenCalledWith(
			discordGuildNamespace("1111"),
			expect.objectContaining({
				role: "assistant",
				content: "ボットの応答 [添付: cap.png]",
			}),
		);
		expect(result).toEqual({ status: "accepted", recorded: true });
	});

	test("ConversationMessage に IncomingMessage.authorId が転送される", async () => {
		// CriticAuditor が authorId でフィルタするため、IngestionService は authorId を保持して
		// ConversationRecorder に渡す責務がある（#847）
		const recordMock = mock(() => Promise.resolve());
		const recorder: ConversationRecorder = { record: recordMock };
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		await service.handleIncomingMessage(
			createMockMessage({
				isBot: true,
				authorId: "1100000000000000001",
				// guild ニックネーム
				authorName: "hua-bot",
				content: "応答",
			}),
			{ recordConversation: true },
		);

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

		const result = await service.handleIncomingMessage(
			createMockMessage({ content: "mention only" }),
		);

		expect(recorder.record).not.toHaveBeenCalled();
		expect(result).toEqual({ status: "accepted", recorded: false });
	});

	test("content も attachments も空なら dropped を返す", async () => {
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger });

		const result = await service.handleIncomingMessage(
			createMockMessage({ content: "", attachments: [] }),
		);

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ status: "dropped", reason: "empty_message" });
	});

	test("会話記録失敗を await 可能な結果として返す", async () => {
		const error = new Error("db unavailable");
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.reject(error)),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ logger, recorder });

		const result = await service.handleIncomingMessage(createMockMessage(), {
			recordConversation: true,
		});

		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ status: "failed", reason: "record_failed", error });
	});
});
