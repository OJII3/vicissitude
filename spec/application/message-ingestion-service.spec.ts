import { describe, expect, mock, test } from "bun:test";

import type { BufferedEventStore } from "../../src/application/message-ingestion-service.ts";
import { MessageIngestionService } from "../../src/application/message-ingestion-service.ts";
import type { BufferedEvent, ConversationRecorder, IncomingMessage } from "@vicissitude/shared/types";
import { createMockLogger } from "../test-helpers.ts";

function createMockMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		platform: "discord",
		channelId: "ch-1",
		guildId: "guild-1",
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
		const eventStore: BufferedEventStore = { append: mock(() => {}) };
		const logger = createMockLogger();
		const service = new MessageIngestionService({ eventStore, logger });

		service.handleIncomingMessage(createMockMessage({ guildId: undefined }));

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(eventStore.append).not.toHaveBeenCalled();
	});

	test("イベントをバッファし、添付だけのメッセージも許可する", () => {
		const buffered: Array<{ agentId: string; event: BufferedEvent }> = [];
		const eventStore: BufferedEventStore = {
			append: mock((agentId: string, event: BufferedEvent) => {
				buffered.push({ agentId, event });
			}),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ eventStore, logger });

		service.handleIncomingMessage(
			createMockMessage({
				content: "",
				attachments: [{ url: "https://example.com/image.png", filename: "image.png" }],
			}),
		);

		expect(buffered).toHaveLength(1);
		expect(buffered[0]?.agentId).toBe("discord:guild-1");
		expect(buffered[0]?.event.attachments?.[0]?.filename).toBe("image.png");
	});

	test("recorder があれば会話記録も行う", async () => {
		const eventStore: BufferedEventStore = { append: mock(() => {}) };
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ eventStore, logger, recorder });

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
			"guild-1",
			expect.objectContaining({
				role: "assistant",
				content: "ボットの応答 [添付: cap.png]",
			}),
		);
	});

	test("bufferEvent=false なら LTM 記録だけ行い event buffer には積まない", async () => {
		const eventStore: BufferedEventStore = { append: mock(() => {}) };
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ eventStore, logger, recorder });

		service.handleIncomingMessage(
			createMockMessage({
				isBot: true,
				content: "自分の発言",
			}),
			{ recordConversation: true, bufferEvent: false },
		);

		await Promise.resolve();

		expect(eventStore.append).not.toHaveBeenCalled();
		expect(recorder.record).toHaveBeenCalledTimes(1);
	});

	test("recordConversation 未指定なら LTM 記録しない", async () => {
		const eventStore: BufferedEventStore = { append: mock(() => {}) };
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const service = new MessageIngestionService({ eventStore, logger, recorder });

		service.handleIncomingMessage(createMockMessage({ content: "mention only" }));
		await Promise.resolve();

		expect(recorder.record).not.toHaveBeenCalled();
	});
});
