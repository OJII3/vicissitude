import { describe, expect, test } from "bun:test";

import { SqliteEventBuffer } from "./event-buffer.ts";
import { insertBridgeEvent, tryAcquireSessionLock } from "./mc-bridge.ts";
import { appendEvent } from "./queries.ts";
import { createTestDb } from "./test-helpers.ts";

describe("SqliteEventBuffer", () => {
	test("event_buffer にイベントがあれば waitForEvents が解決する", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-1");
		appendEvent(db, "guild-1", '{"kind":"discord"}');

		const start = Date.now();
		await buffer.waitForEvents(new AbortController().signal);

		expect(Date.now() - start).toBeLessThan(50);
	});

	test("to_discord の bridge event でも waitForEvents が解決する", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-1");
		tryAcquireSessionLock(db, "guild-1");
		insertBridgeEvent(db, "to_discord", "report", "found diamond");

		const start = Date.now();
		await buffer.waitForEvents(new AbortController().signal);

		expect(Date.now() - start).toBeLessThan(50);
	});

	test("同じ未消費 bridge event では二度起きない", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-1");
		const controller = new AbortController();
		tryAcquireSessionLock(db, "guild-1");
		insertBridgeEvent(db, "to_discord", "report", "found diamond");

		await buffer.waitForEvents(new AbortController().signal);
		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);

		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});

	test("古い未消費 bridge event が残っていても新しい event では再度起きる", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-1");
		tryAcquireSessionLock(db, "guild-1");
		insertBridgeEvent(db, "to_discord", "report", "older report");

		await buffer.waitForEvents(new AbortController().signal);
		insertBridgeEvent(db, "to_discord", "report", "newer report");

		const start = Date.now();
		await buffer.waitForEvents(new AbortController().signal);

		expect(Date.now() - start).toBeLessThan(50);
	});

	test("to_minecraft の bridge event では起きない", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-1");
		const controller = new AbortController();
		insertBridgeEvent(db, "to_minecraft", "command", "go mining");

		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);

		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});

	test("to_discord の bridge event でも lock holder 以外の guild は起きない", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "guild-2");
		const controller = new AbortController();
		tryAcquireSessionLock(db, "guild-1");
		insertBridgeEvent(db, "to_discord", "report", "found diamond");

		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);

		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});
});
