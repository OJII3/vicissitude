import { describe, expect, it, mock } from "bun:test";

import type { BufferedEvent, EventBuffer } from "../../domain/ports/event-buffer.port.ts";
import type { Logger } from "../../domain/ports/logger.port.ts";
import type { IncomingMessage } from "../../domain/ports/message-gateway.port.ts";
import { BufferEventUseCase } from "./buffer-event.use-case.ts";

function createMockBuffer(): EventBuffer {
	return {
		append: mock(() => Promise.resolve()),
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
		isMentioned: false,
		isThread: false,
		reply: mock(() => Promise.resolve()),
		react: mock(() => Promise.resolve()),
		...overrides,
	};
}

describe("BufferEventUseCase", () => {
	it("メッセージをバッファに正しく変換して追加する", async () => {
		const buffer = createMockBuffer();
		const logger = createMockLogger();
		const useCase = new BufferEventUseCase(buffer, logger);

		const msg = createMockMessage("こんにちは", {
			isMentioned: true,
			isThread: true,
			guildId: "guild-456",
		});
		await useCase.execute(msg);

		expect(buffer.append).toHaveBeenCalledTimes(1);
		const [event] = (buffer.append as ReturnType<typeof mock>).mock.calls[0] as [BufferedEvent];
		expect(event.ts).toBe("2026-03-02T12:00:00.000Z");
		expect(event.channelId).toBe("ch-123");
		expect(event.guildId).toBe("guild-456");
		expect(event.authorId).toBe("user-789");
		expect(event.authorName).toBe("TestUser");
		expect(event.messageId).toBe("msg-001");
		expect(event.content).toBe("こんにちは");
		expect(event.isMentioned).toBe(true);
		expect(event.isThread).toBe(true);
	});

	it("空の content はスキップされる", async () => {
		const buffer = createMockBuffer();
		const logger = createMockLogger();
		const useCase = new BufferEventUseCase(buffer, logger);

		await useCase.execute(createMockMessage(""));

		expect(buffer.append).not.toHaveBeenCalled();
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("バッファリング後にログが出力される", async () => {
		const buffer = createMockBuffer();
		const logger = createMockLogger();
		const useCase = new BufferEventUseCase(buffer, logger);

		await useCase.execute(createMockMessage("テスト"));

		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it("content が空でも attachments があればバッファに追加される", async () => {
		const buffer = createMockBuffer();
		const logger = createMockLogger();
		const useCase = new BufferEventUseCase(buffer, logger);

		await useCase.execute(
			createMockMessage("", {
				attachments: [{ url: "https://cdn.discordapp.com/img.png", contentType: "image/png" }],
			}),
		);

		expect(buffer.append).toHaveBeenCalledTimes(1);
		const [event] = (buffer.append as ReturnType<typeof mock>).mock.calls[0] as [BufferedEvent];
		expect(event.content).toBe("");
		expect(event.attachments).toEqual([
			{ url: "https://cdn.discordapp.com/img.png", contentType: "image/png" },
		]);
	});

	it("guildId が undefined でもバッファに追加される", async () => {
		const buffer = createMockBuffer();
		const logger = createMockLogger();
		const useCase = new BufferEventUseCase(buffer, logger);

		await useCase.execute(createMockMessage("DM メッセージ", { guildId: undefined }));

		expect(buffer.append).toHaveBeenCalledTimes(1);
		const [event] = (buffer.append as ReturnType<typeof mock>).mock.calls[0] as [BufferedEvent];
		expect(event.guildId).toBeUndefined();
	});
});
