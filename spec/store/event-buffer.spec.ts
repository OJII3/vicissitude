import { describe, expect, test } from "bun:test";

import { SqliteEventBuffer } from "@vicissitude/store/event-buffer";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

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

	test("ポーリングエラー時に onPollError コールバックが呼ばれる", async () => {
		const db = createTestDb();
		const errors: unknown[] = [];
		const buffer = new SqliteEventBuffer(db, "agent-1", undefined, (err) => {
			errors.push(err);
		});

		// テーブルを DROP してクエリを失敗させる
		db.run("DROP TABLE event_buffer");

		const controller = new AbortController();
		// 少しだけポーリングさせてから abort
		setTimeout(() => controller.abort(), 200);

		await buffer.waitForEvents(controller.signal);

		expect(errors.length).toBeGreaterThan(0);
	});

	test("onPollError が未指定でもエラー時にクラッシュしない", async () => {
		const db = createTestDb();
		const buffer = new SqliteEventBuffer(db, "agent-1");

		db.run("DROP TABLE event_buffer");

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);

		// onPollError なしでもクラッシュせずに resolve する
		const promise = buffer.waitForEvents(controller.signal);
		// abort 後に正常終了すること
		await promise;
	});

	test("正常なポーリングでは onPollError が呼ばれない", async () => {
		const db = createTestDb();
		const errors: unknown[] = [];
		const buffer = new SqliteEventBuffer(db, "agent-1", undefined, (err) => {
			errors.push(err);
		});

		appendEvent(db, "agent-1", '{"kind":"discord"}');

		await buffer.waitForEvents(new AbortController().signal);

		expect(errors).toHaveLength(0);
	});
});
