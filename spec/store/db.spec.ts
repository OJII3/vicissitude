import { describe, expect, test } from "bun:test";

import {
	appendEvent,
	consumeNextEvent,
	consumeEvents,
	deleteSession,
	getSession,
	getTopEmojis,
	incrementEmoji,
	saveSession,
} from "@vicissitude/store/queries";
import { createTestDb } from "../../packages/store/src/test-helpers.ts";

describe("store", () => {
	describe("table creation", () => {
		test("all tables exist", () => {
			const db = createTestDb();
			const tables = db.$client
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			const tableNames = tables.map((t) => t.name);
			expect(tableNames).toContain("sessions");
			expect(tableNames).toContain("emoji_usage");
			expect(tableNames).toContain("event_buffer");
			expect(tableNames).toContain("mc_session_lock");
		});
	});

	describe("sessions CRUD", () => {
		test("save and get a session", () => {
			const db = createTestDb();
			saveSession(db, "agent:channel:user", "sid-001");
			const result = getSession(db, "agent:channel:user");
			expect(result).toBeDefined();
			expect(result?.sessionId).toBe("sid-001");
			expect(result?.createdAt).toBeGreaterThan(0);
		});

		test("get returns undefined for missing session", () => {
			const db = createTestDb();
			const result = getSession(db, "nonexistent");
			expect(result).toBeUndefined();
		});

		test("save overwrites existing session", () => {
			const db = createTestDb();
			saveSession(db, "key1", "sid-a");
			saveSession(db, "key1", "sid-b");
			const result = getSession(db, "key1");
			expect(result?.sessionId).toBe("sid-b");
		});

		test("delete removes session", () => {
			const db = createTestDb();
			saveSession(db, "key1", "sid-a");
			deleteSession(db, "key1");
			const result = getSession(db, "key1");
			expect(result).toBeUndefined();
		});

		test("delete nonexistent key does not throw", () => {
			const db = createTestDb();
			expect(() => deleteSession(db, "nonexistent")).not.toThrow();
		});
	});

	describe("event_buffer", () => {
		test("append and consume events", () => {
			const db = createTestDb();
			appendEvent(db, "guild-1", JSON.stringify({ type: "message", text: "hello" }));
			appendEvent(db, "guild-1", JSON.stringify({ type: "message", text: "world" }));
			appendEvent(db, "guild-2", JSON.stringify({ type: "message", text: "other" }));

			const events = consumeEvents(db, "guild-1");
			expect(events).toHaveLength(2);
			expect(JSON.parse(events[0]?.payload ?? "")).toEqual({ type: "message", text: "hello" });
			expect(JSON.parse(events[1]?.payload ?? "")).toEqual({ type: "message", text: "world" });
		});

		test("consume deletes events", () => {
			const db = createTestDb();
			appendEvent(db, "guild-1", JSON.stringify({ type: "a" }));
			consumeEvents(db, "guild-1");
			const remaining = consumeEvents(db, "guild-1");
			expect(remaining).toHaveLength(0);
		});

		test("consume does not affect other guilds", () => {
			const db = createTestDb();
			appendEvent(db, "guild-1", JSON.stringify({ type: "a" }));
			appendEvent(db, "guild-2", JSON.stringify({ type: "b" }));
			consumeEvents(db, "guild-1");
			const guild2Events = consumeEvents(db, "guild-2");
			expect(guild2Events).toHaveLength(1);
		});

		test("consumeNextEvent は最古の 1 件だけ消費する", () => {
			const db = createTestDb();
			appendEvent(db, "guild-1", JSON.stringify({ type: "first" }));
			appendEvent(db, "guild-1", JSON.stringify({ type: "second" }));

			const first = consumeNextEvent(db, "guild-1");
			const remaining = consumeEvents(db, "guild-1");

			expect(JSON.parse(first?.payload ?? "")).toEqual({ type: "first" });
			expect(remaining).toHaveLength(1);
			expect(JSON.parse(remaining[0]?.payload ?? "")).toEqual({ type: "second" });
		});

		test("consumeEvents with limit は指定件数だけ消費する", () => {
			const db = createTestDb();
			appendEvent(db, "guild-1", JSON.stringify({ type: "a" }));
			appendEvent(db, "guild-1", JSON.stringify({ type: "b" }));
			appendEvent(db, "guild-1", JSON.stringify({ type: "c" }));

			const batch = consumeEvents(db, "guild-1", 2);
			expect(batch).toHaveLength(2);
			expect(JSON.parse(batch[0]?.payload ?? "")).toEqual({ type: "a" });
			expect(JSON.parse(batch[1]?.payload ?? "")).toEqual({ type: "b" });

			const remaining = consumeEvents(db, "guild-1");
			expect(remaining).toHaveLength(1);
			expect(JSON.parse(remaining[0]?.payload ?? "")).toEqual({ type: "c" });
		});
	});

	describe("emoji_usage", () => {
		test("increment creates entry with count 1", () => {
			const db = createTestDb();
			incrementEmoji(db, "guild-1", "thumbsup");
			const top = getTopEmojis(db, "guild-1", 10);
			expect(top).toHaveLength(1);
			expect(top[0]?.emojiName).toBe("thumbsup");
			expect(top[0]?.count).toBe(1);
		});

		test("increment adds to existing count", () => {
			const db = createTestDb();
			incrementEmoji(db, "guild-1", "fire");
			incrementEmoji(db, "guild-1", "fire");
			incrementEmoji(db, "guild-1", "fire");
			const top = getTopEmojis(db, "guild-1", 10);
			expect(top[0]?.count).toBe(3);
		});

		test("getTopEmojis returns sorted by count descending", () => {
			const db = createTestDb();
			incrementEmoji(db, "guild-1", "a");
			incrementEmoji(db, "guild-1", "b");
			incrementEmoji(db, "guild-1", "b");
			incrementEmoji(db, "guild-1", "c");
			incrementEmoji(db, "guild-1", "c");
			incrementEmoji(db, "guild-1", "c");

			const top = getTopEmojis(db, "guild-1", 2);
			expect(top).toHaveLength(2);
			expect(top[0]?.emojiName).toBe("c");
			expect(top[0]?.count).toBe(3);
			expect(top[1]?.emojiName).toBe("b");
			expect(top[1]?.count).toBe(2);
		});

		test("getTopEmojis returns empty for unknown guild", () => {
			const db = createTestDb();
			const top = getTopEmojis(db, "nonexistent", 10);
			expect(top).toHaveLength(0);
		});

		test("emoji counts are guild-scoped", () => {
			const db = createTestDb();
			incrementEmoji(db, "guild-1", "star");
			incrementEmoji(db, "guild-2", "star");
			incrementEmoji(db, "guild-2", "star");

			const g1 = getTopEmojis(db, "guild-1", 10);
			const g2 = getTopEmojis(db, "guild-2", 10);
			expect(g1[0]?.count).toBe(1);
			expect(g2[0]?.count).toBe(2);
		});
	});
});
