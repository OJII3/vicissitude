import { describe, expect, it, mock } from "bun:test";

import type {
	ConversationMessage,
	ConversationRecorder,
} from "../../domain/ports/conversation-recorder.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";
import { RecordConversationUseCase } from "./record-conversation.use-case.ts";

function createMockRecorder(): ConversationRecorder {
	return {
		record: mock(() => Promise.resolve()),
	};
}

function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}

function createMockMessage(content: string, overrides?: Partial<IncomingMessage>): IncomingMessage {
	return {
		platform: "discord",
		channelId: "ch-123",
		guildId: "guild-456",
		authorId: "user-789",
		authorName: "TestUser",
		messageId: "msg-001",
		content,
		attachments: [],
		timestamp: new Date("2026-03-02T12:00:00Z"),
		isBot: false,
		isMentioned: false,
		isThread: false,
		reply: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		...overrides,
	};
}

describe("RecordConversationUseCase", () => {
	it("ユーザーメッセージを user ロールで記録する", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(createMockMessage("こんにちは"));

		expect(recorder.record).toHaveBeenCalledTimes(1);
		const [guildId, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(guildId).toBe("guild-456");
		expect(msg.role).toBe("user");
		expect(msg.content).toBe("TestUser: こんにちは");
		expect(msg.timestamp).toEqual(new Date("2026-03-02T12:00:00Z"));
	});

	it("bot メッセージを assistant ロールで記録する", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(
			createMockMessage("はい、お手伝いします", { isBot: true, authorName: "ふあ" }),
		);

		const [, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(msg.role).toBe("assistant");
		expect(msg.content).toBe("ふあ: はい、お手伝いします");
	});

	it("guildId が undefined のメッセージはスキップする", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(createMockMessage("DM", { guildId: undefined }));

		expect(recorder.record).not.toHaveBeenCalled();
	});

	it("content も attachments も空のメッセージはスキップする", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(createMockMessage(""));

		expect(recorder.record).not.toHaveBeenCalled();
	});

	it("添付ファイル情報を content に追加する", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(
			createMockMessage("見てこれ", {
				attachments: [
					{
						url: "https://cdn.example.com/image.png",
						contentType: "image/png",
						filename: "image.png",
					},
				],
			}),
		);

		const [, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(msg.content).toBe("TestUser: 見てこれ [添付: image.png]");
	});

	it("content が空で attachments のみの場合も記録する", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(
			createMockMessage("", {
				attachments: [
					{
						url: "https://cdn.example.com/doc.pdf",
						contentType: "application/pdf",
						filename: "doc.pdf",
					},
				],
			}),
		);

		expect(recorder.record).toHaveBeenCalledTimes(1);
		const [, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(msg.content).toBe("TestUser: [添付: doc.pdf]");
	});

	it("記録後にログが出力される", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(createMockMessage("テスト"));

		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it("recorder.record() が失敗した場合、例外が伝播する", async () => {
		const recorder = createMockRecorder();
		(recorder.record as ReturnType<typeof mock>).mockImplementation(() =>
			Promise.reject(new Error("DB connection failed")),
		);
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await expect(useCase.execute(createMockMessage("テスト"))).rejects.toThrow(
			"DB connection failed",
		);
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("filename が undefined の添付ファイルは 'unknown' と表示する", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(
			createMockMessage("", {
				attachments: [
					{
						url: "https://cdn.example.com/file",
						contentType: "application/octet-stream",
					},
				],
			}),
		);

		const [, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(msg.content).toBe("TestUser: [添付: unknown]");
	});

	it("複数の添付ファイルがスペース区切りで結合される", async () => {
		const recorder = createMockRecorder();
		const logger = createMockLogger();
		const useCase = new RecordConversationUseCase(recorder, logger);

		await useCase.execute(
			createMockMessage("ファイル送るね", {
				attachments: [
					{ url: "https://example.com/a.png", contentType: "image/png", filename: "a.png" },
					{
						url: "https://example.com/b.pdf",
						contentType: "application/pdf",
						filename: "b.pdf",
					},
				],
			}),
		);

		const [, msg] = (recorder.record as ReturnType<typeof mock>).mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(msg.content).toBe("TestUser: ファイル送るね [添付: a.png] [添付: b.pdf]");
	});
});
