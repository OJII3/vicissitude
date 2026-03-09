import { describe, expect, test } from "bun:test";

import {
	consumeBridgeEvents,
	hasBridgeEvents,
	insertBridgeEvent,
	peekBridgeEvents,
} from "./mc-bridge.ts";
import { createTestDb } from "./test-helpers.ts";

describe("mc-bridge", () => {
	describe("insertBridgeEvent", () => {
		test("inserts an event", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_sub", "command", "go to forest");
			const events = peekBridgeEvents(db, "to_sub");
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("command");
			expect(events[0]?.payload).toBe("go to forest");
			expect(events[0]?.direction).toBe("to_sub");
			expect(events[0]?.createdAt).toBeGreaterThan(0);
		});
	});

	describe("consumeBridgeEvents", () => {
		test("returns and marks events as consumed", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", '{"message":"found diamond"}');
			insertBridgeEvent(db, "to_main", "report", '{"message":"built house"}');

			const events = consumeBridgeEvents(db, "to_main");
			expect(events).toHaveLength(2);
			expect(events[0]?.payload).toBe('{"message":"found diamond"}');
			expect(events[1]?.payload).toBe('{"message":"built house"}');
		});

		test("consumed events are not returned again", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "test");
			consumeBridgeEvents(db, "to_main");

			const remaining = consumeBridgeEvents(db, "to_main");
			expect(remaining).toHaveLength(0);
		});

		test("does not affect other direction", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "for main");
			insertBridgeEvent(db, "to_sub", "command", "for sub");

			consumeBridgeEvents(db, "to_main");

			const subEvents = consumeBridgeEvents(db, "to_sub");
			expect(subEvents).toHaveLength(1);
			expect(subEvents[0]?.payload).toBe("for sub");
		});

		test("returns empty array when no events", () => {
			const db = createTestDb();
			const events = consumeBridgeEvents(db, "to_main");
			expect(events).toHaveLength(0);
		});
	});

	describe("peekBridgeEvents", () => {
		test("returns events without consuming them", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "peeked");

			const peeked = peekBridgeEvents(db, "to_main");
			expect(peeked).toHaveLength(1);

			const stillThere = consumeBridgeEvents(db, "to_main");
			expect(stillThere).toHaveLength(1);
			expect(stillThere[0]?.payload).toBe("peeked");
		});

		test("filters by direction", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "main event");
			insertBridgeEvent(db, "to_sub", "command", "sub event");

			const mainEvents = peekBridgeEvents(db, "to_main");
			expect(mainEvents).toHaveLength(1);
			expect(mainEvents[0]?.direction).toBe("to_main");
		});
	});

	describe("hasBridgeEvents", () => {
		test("returns false when no events", () => {
			const db = createTestDb();
			expect(hasBridgeEvents(db, "to_main")).toBe(false);
		});

		test("returns true when unconsumed events exist", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "test");
			expect(hasBridgeEvents(db, "to_main")).toBe(true);
		});

		test("returns false after events are consumed", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_main", "report", "test");
			consumeBridgeEvents(db, "to_main");
			expect(hasBridgeEvents(db, "to_main")).toBe(false);
		});

		test("is direction-scoped", () => {
			const db = createTestDb();
			insertBridgeEvent(db, "to_sub", "command", "test");
			expect(hasBridgeEvents(db, "to_main")).toBe(false);
			expect(hasBridgeEvents(db, "to_sub")).toBe(true);
		});
	});
});
