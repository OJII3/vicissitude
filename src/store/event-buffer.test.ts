import { describe, expect, test } from "bun:test";

import { SqliteEventBuffer } from "./event-buffer.ts";
import { appendEvent } from "./queries.ts";
import { createTestDb } from "./test-helpers.ts";

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

	test("hasEvents が例外をスローしてもポーリングが途切れずイベント検知で解決する", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");

		// テーブルを一時的に DROP してクエリを失敗させる
		const DROP = "DROP TABLE event_buffer";
		const CREATE =
			"CREATE TABLE event_buffer (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)";
		db.run(DROP);

		const waitPromise = buffer.waitForEvents(new AbortController().signal);

		// 50ms 後にテーブルを再作成してイベントを追加
		setTimeout(() => {
			db.run(CREATE);
			appendEvent(db, "agent-1", '{"kind":"recovery"}');
		}, 50);

		const start = Date.now();
		await waitPromise;
		// try-catch により例外後もポーリングが継続し、テーブル復元後にイベントを検知
		expect(Date.now() - start).toBeLessThan(3000);
	});
});
