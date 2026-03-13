import { describe, expect, test } from "bun:test";

import {
	clearSessionLock,
	consumeBridgeEvents,
	consumeBridgeEventsByType,
	hasBridgeEvents,
	insertBridgeEvent,
	markStaleEventsConsumedOnSpawn,
	peekBridgeEvents,
	releaseSessionLock,
	releaseSessionLockAndStop,
	tryAcquireSessionLock,
} from "./mc-bridge.ts";
import { mcSessionLock } from "./schema.ts";
import { createTestDb } from "./test-helpers.ts";

describe("mc-bridge", () => {
	describe("insertBridgeEvent", () => {
		test("inserts an event", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "command", "go to forest");
			const events = peekBridgeEvents(db, "to_minecraft");
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("command");
			expect(events[0]?.payload).toBe("go to forest");
			expect(events[0]?.direction).toBe("to_minecraft");
			expect(events[0]?.createdAt).toBeGreaterThan(0);
		});
	});

	describe("consumeBridgeEvents", () => {
		test("returns and marks events as consumed", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", '{"message":"found diamond"}');
			insertBridgeEvent(db, "to_discord", "report", '{"message":"built house"}');

			const events = consumeBridgeEvents(db, "to_discord");
			expect(events).toHaveLength(2);
			expect(events[0]?.payload).toBe('{"message":"found diamond"}');
			expect(events[1]?.payload).toBe('{"message":"built house"}');
		});

		test("consumed events are not returned again", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "test");
			consumeBridgeEvents(db, "to_discord");

			const remaining = consumeBridgeEvents(db, "to_discord");
			expect(remaining).toHaveLength(0);
		});

		test("does not affect other direction", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "for main");
			insertBridgeEvent(db, "to_minecraft", "command", "for sub");

			consumeBridgeEvents(db, "to_discord");

			const subEvents = consumeBridgeEvents(db, "to_minecraft");
			expect(subEvents).toHaveLength(1);
			expect(subEvents[0]?.payload).toBe("for sub");
		});

		test("returns empty array when no events", () => {
			const db = createTestDb();
			const events = consumeBridgeEvents(db, "to_discord");
			expect(events).toHaveLength(0);
		});
	});

	describe("peekBridgeEvents", () => {
		test("returns events without consuming them", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "peeked");

			const peeked = peekBridgeEvents(db, "to_discord");
			expect(peeked).toHaveLength(1);

			const stillThere = consumeBridgeEvents(db, "to_discord");
			expect(stillThere).toHaveLength(1);
			expect(stillThere[0]?.payload).toBe("peeked");
		});

		test("filters by direction", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "main event");
			insertBridgeEvent(db, "to_minecraft", "command", "sub event");

			const mainEvents = peekBridgeEvents(db, "to_discord");
			expect(mainEvents).toHaveLength(1);
			expect(mainEvents[0]?.direction).toBe("to_discord");
		});
	});

	describe("consumeBridgeEventsByType", () => {
		test("consumes only events of the specified type", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "command", "go to forest");
			insertBridgeEvent(db, "to_minecraft", "lifecycle", "start");
			insertBridgeEvent(db, "to_minecraft", "command", "mine diamonds");

			const lifecycleEvents = consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");
			expect(lifecycleEvents).toHaveLength(1);
			expect(lifecycleEvents[0]?.type).toBe("lifecycle");
			expect(lifecycleEvents[0]?.payload).toBe("start");

			// command events should remain unconsumed
			const commandEvents = consumeBridgeEventsByType(db, "to_minecraft", "command");
			expect(commandEvents).toHaveLength(2);
		});

		test("consumed events are not returned again", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "lifecycle", "start");
			consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");

			const remaining = consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");
			expect(remaining).toHaveLength(0);
		});

		test("returns empty array when no events of the type exist", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "command", "test");

			const events = consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");
			expect(events).toHaveLength(0);
		});

		test("does not affect other direction", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "found diamond");
			insertBridgeEvent(db, "to_minecraft", "lifecycle", "start");

			consumeBridgeEventsByType(db, "to_minecraft", "lifecycle");

			const mainEvents = peekBridgeEvents(db, "to_discord");
			expect(mainEvents).toHaveLength(1);
		});
	});

	describe("hasBridgeEvents", () => {
		test("returns false when no events", () => {
			const db = createTestDb();
			expect(hasBridgeEvents(db, "to_discord")).toBe(false);
		});

		test("returns true when unconsumed events exist", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "test");
			expect(hasBridgeEvents(db, "to_discord")).toBe(true);
		});

		test("returns false after events are consumed", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", "test");
			consumeBridgeEvents(db, "to_discord");
			expect(hasBridgeEvents(db, "to_discord")).toBe(false);
		});

		test("is direction-scoped", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "command", "test");
			expect(hasBridgeEvents(db, "to_discord")).toBe(false);
			expect(hasBridgeEvents(db, "to_minecraft")).toBe(true);
		});
	});

	describe("markStaleEventsConsumedOnSpawn", () => {
		test("未消費の to_discord report/command を消費済みにする", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_discord", "report", '{"message":"old report"}');
			insertBridgeEvent(db, "to_discord", "command", "old command");
			insertBridgeEvent(db, "to_discord", "lifecycle", "spawn");

			const changed = markStaleEventsConsumedOnSpawn(db);

			expect(changed).toBe(2);
			// report と command は消費済み
			const remaining = peekBridgeEvents(db, "to_discord");
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.type).toBe("lifecycle");
		});

		test("to_minecraft のイベントには影響しない", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_minecraft", "command", "go forest");
			insertBridgeEvent(db, "to_discord", "report", '{"message":"old"}');

			markStaleEventsConsumedOnSpawn(db);

			const mcEvents = peekBridgeEvents(db, "to_minecraft");
			expect(mcEvents).toHaveLength(1);
		});

		test("未消費イベントがない場合は 0 を返す", () => {
			const db = createTestDb();
			const changed = markStaleEventsConsumedOnSpawn(db);
			expect(changed).toBe(0);
		});
	});

	describe("tryAcquireSessionLock", () => {
		test("acquires lock when no existing lock", () => {
			const db = createTestDb();
			const result = tryAcquireSessionLock(db, "guild-1");
			expect(result).toEqual({ ok: true });
		});

		test("re-acquires lock for same guildId (idempotent)", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-1");
			expect(result).toEqual({ ok: true });
		});

		test("rejects lock when different guild holds it", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: false, holder: "guild-1" });
		});

		test("acquires lock via timeout when holder is expired", () => {
			const db = createTestDb();
			// 直接 DB に古いタイムスタンプを挿入（2時間超過）
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000 - 1;
			db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: twoHoursAgo }).run();

			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});

		test("rejects lock when holder is not yet expired", () => {
			const db = createTestDb();
			// 1時間前 — まだタイムアウトしていない
			const oneHourAgo = Date.now() - 60 * 60 * 1000;
			db.insert(mcSessionLock).values({ id: 1, guildId: "guild-1", acquiredAt: oneHourAgo }).run();

			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: false, holder: "guild-1" });
		});
	});

	describe("releaseSessionLock", () => {
		test("releases own lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLock(db, "guild-1");
			expect(result).toBe(true);
		});

		test("returns false when no lock exists", () => {
			const db = createTestDb();
			const result = releaseSessionLock(db, "guild-1");
			expect(result).toBe(false);
		});

		test("returns false when different guild holds the lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLock(db, "guild-2");
			expect(result).toBe(false);
		});

		test("allows re-acquisition after release", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			releaseSessionLock(db, "guild-1");
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});
	});

	describe("releaseSessionLockAndStop", () => {
		test("releases lock and inserts stop event atomically", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLockAndStop(db, "guild-1");
			expect(result).toBe(true);

			// ロックが解放されている
			const reacquire = tryAcquireSessionLock(db, "guild-2");
			expect(reacquire).toEqual({ ok: true });

			// stop イベントが挿入されている
			const events = consumeBridgeEvents(db, "to_minecraft");
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("lifecycle");
			expect(events[0]?.payload).toBe("stop");
		});

		test("returns false when different guild holds the lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			const result = releaseSessionLockAndStop(db, "guild-2");
			expect(result).toBe(false);

			// stop イベントが挿入されていない
			const events = consumeBridgeEvents(db, "to_minecraft");
			expect(events).toHaveLength(0);
		});
	});

	describe("clearSessionLock", () => {
		test("clears existing lock", () => {
			const db = createTestDb();
			tryAcquireSessionLock(db, "guild-1");
			clearSessionLock(db);
			// ロックがクリアされたので再取得可能
			const result = tryAcquireSessionLock(db, "guild-2");
			expect(result).toEqual({ ok: true });
		});

		test("does not throw when no lock exists", () => {
			const db = createTestDb();
			expect(() => clearSessionLock(db)).not.toThrow();
		});
	});
});
