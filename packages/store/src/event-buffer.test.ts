import { describe, expect, mock, test } from "bun:test";

import type { Logger } from "@vicissitude/shared/types";

import { SqliteEventBuffer } from "./event-buffer.ts";
import { appendEvent } from "./queries.ts";
import { createTestDb } from "./test-helpers.ts";

describe("SqliteEventBuffer (internal: error recovery)", () => {
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

describe("SqliteEventBuffer (internal: onPollError callback)", () => {
	test("onPollError にスローされたエラーオブジェクトがそのまま渡される", async () => {
		const db = createTestDb();
		const errors: unknown[] = [];
		const buffer = new SqliteEventBuffer(db, "agent-1", undefined, (err) => {
			errors.push(err);
		});

		db.run("DROP TABLE event_buffer");

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);

		await buffer.waitForEvents(controller.signal);

		expect(errors.length).toBeGreaterThan(0);
		// SQLite のエラーオブジェクトが渡される
		for (const err of errors) {
			expect(err).toBeInstanceOf(Error);
		}
	});

	test("ポーリングのたびに onPollError が毎回呼ばれる", async () => {
		const db = createTestDb();
		const callback = mock((_err: unknown) => {});
		const buffer = new SqliteEventBuffer(db, "agent-1", undefined, (err) => {
			callback(err);
		});

		db.run("DROP TABLE event_buffer");

		const controller = new AbortController();
		// 初回ポーリング間隔 500ms、2回目 750ms なので 1500ms あれば複数回呼ばれる
		setTimeout(() => controller.abort(), 1500);

		await buffer.waitForEvents(controller.signal);

		// 複数回ポーリングされるので複数回呼ばれる
		expect(callback.mock.calls.length).toBeGreaterThan(1);
	});

	test("エラー後にイベントが見つかると consecutivePollErrors がリセットされ logger.error にならない", async () => {
		const db = createTestDb();
		const logger = {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			child() {
				return logger as Logger;
			},
		};
		const callback = mock((_err: unknown) => {});
		const buffer = new SqliteEventBuffer(db, "agent-1", logger, (err) => {
			callback(err);
		});

		const DROP = "DROP TABLE event_buffer";
		const CREATE =
			"CREATE TABLE event_buffer (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)";
		db.run(DROP);

		const waitPromise = buffer.waitForEvents(new AbortController().signal);

		// 少し待ってからテーブル復元 + イベント追加
		setTimeout(() => {
			db.run(CREATE);
			appendEvent(db, "agent-1", '{"kind":"recovery"}');
		}, 100);

		await waitPromise;

		// エラーは発生したが閾値未満なので error ではなく warn が呼ばれる
		expect(callback.mock.calls.length).toBeGreaterThan(0);
		expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
		// 閾値(10)未満なので error は呼ばれない
		expect(logger.error).not.toHaveBeenCalled();
	});

	test("連続エラー時に logger.warn が毎回呼ばれる", async () => {
		const db = createTestDb();
		const logger = {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			child() {
				return logger as Logger;
			},
		};
		const buffer = new SqliteEventBuffer(db, "agent-1", logger);

		db.run("DROP TABLE event_buffer");

		const controller = new AbortController();
		// 閾値(10)未満のエラー回数でも logger.warn が呼ばれることを確認
		setTimeout(() => controller.abort(), 1500);

		await buffer.waitForEvents(controller.signal);

		// エラーのたびに warn が呼ばれる（閾値未満なので error ではなく warn）
		expect(logger.warn.mock.calls.length).toBeGreaterThan(0);
	});
});
