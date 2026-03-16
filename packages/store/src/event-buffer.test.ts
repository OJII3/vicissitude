import { describe, expect, test } from "bun:test";

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
