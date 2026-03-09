import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type {
	ConversationMessage,
	ConversationRecorder,
	IncomingMessage,
	Logger,
} from "../core/types.ts";
import { consumeEvents } from "../store/queries.ts";
import * as schema from "../store/schema.ts";
import { bufferIncomingMessage, recordLtmMessage } from "./message-handlers.ts";

// ─── Helpers ─────────────────────────────────────────────────────

function createTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA journal_mode = WAL");
	sqlite.exec(`
		CREATE TABLE sessions (
			key TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE reminders (
			id TEXT PRIMARY KEY,
			guild_id TEXT,
			description TEXT NOT NULL,
			schedule_type TEXT NOT NULL,
			schedule_value TEXT NOT NULL,
			last_executed_at TEXT,
			enabled INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE emoji_usage (
			guild_id TEXT NOT NULL,
			emoji_name TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (guild_id, emoji_name)
		);
		CREATE TABLE event_buffer (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			guild_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE heartbeat_config (
			key TEXT PRIMARY KEY DEFAULT 'default',
			base_interval_minutes INTEGER NOT NULL DEFAULT 1
		);
	`);
	return drizzle(sqlite, { schema });
}

function createMockLogger(): Logger {
	return {
		info: mock(() => {}),
		error: mock(() => {}),
		warn: mock(() => {}),
	};
}

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

// ─── recordLtmMessage ────────────────────────────────────────────

describe("recordLtmMessage", () => {
	test("user メッセージは role=user で記録される", () => {
		const recorded: ConversationMessage[] = [];
		const recorder: ConversationRecorder = {
			record: mock((guildId: string, message: ConversationMessage) => {
				recorded.push(message);
				return Promise.resolve();
			}),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({ isBot: false, content: "ユーザーの発言" });

		recordLtmMessage(recorder, msg, logger);

		expect(recorder.record).toHaveBeenCalledTimes(1);
		expect(recorded[0]?.role).toBe("user");
		expect(recorded[0]?.content).toBe("ユーザーの発言");
	});

	test("bot メッセージは role=assistant で記録される", () => {
		const recorded: ConversationMessage[] = [];
		const recorder: ConversationRecorder = {
			record: mock((_guildId: string, message: ConversationMessage) => {
				recorded.push(message);
				return Promise.resolve();
			}),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({ isBot: true, content: "ボットの応答" });

		recordLtmMessage(recorder, msg, logger);

		expect(recorded[0]?.role).toBe("assistant");
	});

	test("guildId が undefined の場合はスキップ", () => {
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({ guildId: undefined });

		recordLtmMessage(recorder, msg, logger);

		expect(recorder.record).not.toHaveBeenCalled();
	});

	test("空 content + 空 attachments の場合はスキップ", () => {
		const recorder: ConversationRecorder = {
			record: mock(() => Promise.resolve()),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({ content: "", attachments: [] });

		recordLtmMessage(recorder, msg, logger);

		expect(recorder.record).not.toHaveBeenCalled();
	});

	test("添付ファイル情報が content に追加される", () => {
		const recorded: ConversationMessage[] = [];
		const recorder: ConversationRecorder = {
			record: mock((_guildId: string, message: ConversationMessage) => {
				recorded.push(message);
				return Promise.resolve();
			}),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({
			content: "テキスト",
			attachments: [{ url: "https://example.com/image.png", filename: "image.png" }],
		});

		recordLtmMessage(recorder, msg, logger);

		expect(recorded[0]?.content).toBe("テキスト [添付: image.png]");
	});

	test("filename が undefined の時に 'unknown' が使われる", () => {
		const recorded: ConversationMessage[] = [];
		const recorder: ConversationRecorder = {
			record: mock((_guildId: string, message: ConversationMessage) => {
				recorded.push(message);
				return Promise.resolve();
			}),
		};
		const logger = createMockLogger();
		const msg = createMockMessage({
			content: "",
			attachments: [{ url: "https://example.com/file" }],
		});

		recordLtmMessage(recorder, msg, logger);

		expect(recorded[0]?.content).toBe("[添付: unknown]");
	});
});

// ─── bufferIncomingMessage ───────────────────────────────────────

describe("bufferIncomingMessage", () => {
	test("空 content + 空 attachments のメッセージはスキップ", () => {
		const db = createTestDb();
		const logger = createMockLogger();
		const msg = createMockMessage({ content: "", attachments: [] });

		bufferIncomingMessage(db, msg, logger);

		const events = consumeEvents(db, "guild-1");
		expect(events).toHaveLength(0);
	});

	test("guildId が undefined の場合は warn ログを出してスキップ", () => {
		const db = createTestDb();
		const logger = createMockLogger();
		const msg = createMockMessage({ guildId: undefined });

		bufferIncomingMessage(db, msg, logger);

		expect(logger.warn).toHaveBeenCalledTimes(1);
		const events = consumeEvents(db, "guild-1");
		expect(events).toHaveLength(0);
	});

	test("正常なメッセージがバッファリングされる", () => {
		const db = createTestDb();
		const logger = createMockLogger();
		const msg = createMockMessage({
			channelId: "ch-1",
			guildId: "guild-1",
			authorId: "user-1",
			authorName: "TestUser",
			content: "hello world",
		});

		bufferIncomingMessage(db, msg, logger);

		const events = consumeEvents(db, "guild-1");
		expect(events).toHaveLength(1);
		const payload = JSON.parse(events[0]?.payload ?? "");
		expect(payload.channelId).toBe("ch-1");
		expect(payload.guildId).toBe("guild-1");
		expect(payload.authorName).toBe("TestUser");
		expect(payload.content).toBe("hello world");
		expect(payload.isBot).toBe(false);
	});

	test("添付ファイル付きメッセージが正しくバッファリングされる", () => {
		const db = createTestDb();
		const logger = createMockLogger();
		const msg = createMockMessage({
			content: "画像あり",
			attachments: [{ url: "https://example.com/img.png", filename: "img.png" }],
		});

		bufferIncomingMessage(db, msg, logger);

		const events = consumeEvents(db, "guild-1");
		expect(events).toHaveLength(1);
		const payload = JSON.parse(events[0]?.payload ?? "");
		expect(payload.content).toBe("画像あり");
		expect(payload.attachments).toHaveLength(1);
		expect(payload.attachments[0].filename).toBe("img.png");
	});

	test("content が空でも添付ファイルがあればバッファリングされる", () => {
		const db = createTestDb();
		const logger = createMockLogger();
		const msg = createMockMessage({
			content: "",
			attachments: [{ url: "https://example.com/file.pdf", filename: "file.pdf" }],
		});

		bufferIncomingMessage(db, msg, logger);

		const events = consumeEvents(db, "guild-1");
		expect(events).toHaveLength(1);
	});
});
