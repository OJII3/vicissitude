import { describe, expect, test } from "bun:test";

import { SqliteEventBuffer } from "../../src/store/event-buffer.ts";
import { appendEvent } from "../../src/store/queries.ts";
import { createTestDb } from "../../src/store/test-helpers.ts";

describe("SqliteEventBuffer", () => {
	test("event_buffer にイベントがあれば waitForEvents が解決する", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");
		appendEvent(db, "agent-1", '{"kind":"discord"}');

		const start = Date.now();
		await buffer.waitForEvents(new AbortController().signal);

		expect(Date.now() - start).toBeLessThan(50);
	});

	test("別の agentId のイベントでは起きない", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");
		const controller = new AbortController();
		appendEvent(db, "agent-2", '{"kind":"discord"}');

		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);

		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});

	test("イベントがない場合は abort されるまで待つ", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 50);

		const start = Date.now();
		await buffer.waitForEvents(controller.signal);

		expect(Date.now() - start).toBeGreaterThanOrEqual(45);
	});

	test("append で挿入したイベントで waitForEvents が解決する", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");

		buffer.append({
			ts: new Date().toISOString(),
			content: "test",
			authorId: "user",
			authorName: "User",
			messageId: "msg-1",
		});

		const start = Date.now();
		await buffer.waitForEvents(new AbortController().signal);

		expect(Date.now() - start).toBeLessThan(50);
	});
});
