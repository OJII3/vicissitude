import { describe, expect, test } from "bun:test";

import { appendEvent } from "@vicissitude/store/queries";

import { formatEvents, pollEvents } from "../../../packages/mcp/src/tools/event-buffer.ts";
import { createTestDb } from "../../../packages/store/src/test-helpers.ts";

describe("formatEvents", () => {
	test("有効な JSON ペイロードをパースして整形する", () => {
		const rows = [{ payload: '{"channelId":"ch1","content":"hello"}' }];
		const result = formatEvents(rows);
		const parsed = JSON.parse(result);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].channelId).toBe("ch1");
	});

	test("不正な JSON ペイロードにはエラー情報を付与する", () => {
		const rows = [{ payload: "not-json" }];
		const result = formatEvents(rows);
		const parsed = JSON.parse(result);
		expect(parsed[0]._raw).toBe("not-json");
		expect(parsed[0]._error).toBe("invalid JSON");
	});

	test("空配列なら空の JSON 配列を返す", () => {
		const result = formatEvents([]);
		expect(JSON.parse(result)).toEqual([]);
	});
});

describe("pollEvents", () => {
	test("イベントが既にあれば即座にまとめて返す", async () => {
		const db = createTestDb();
		appendEvent(db, "guild-1", '{"content":"test"}');
		appendEvent(db, "guild-1", '{"content":"next"}');

		const deadline = Date.now() + 5000;
		const result = await pollEvents(db, "guild-1", deadline);

		expect(result).not.toBeNull();
		const parsed = JSON.parse(result ?? "[]");
		expect(parsed).toHaveLength(2);
		expect(parsed[0].content).toBe("test");
		expect(parsed[1].content).toBe("next");
	});

	test("タイムアウト時は null を返す", async () => {
		const db = createTestDb();

		const deadline = Date.now() + 300;
		const result = await pollEvents(db, "guild-1", deadline, 50);

		expect(result).toBeNull();
	});

	test("イベントが遅れて到着しても検出する", async () => {
		const db = createTestDb();

		// 50ms 後にイベントを挿入
		setTimeout(() => {
			appendEvent(db, "guild-1", '{"content":"delayed"}');
		}, 50);

		const deadline = Date.now() + 500;
		const result = await pollEvents(db, "guild-1", deadline, 30);

		expect(result).not.toBeNull();
		const parsed = JSON.parse(result ?? "[]");
		expect(parsed[0].content).toBe("delayed");
	});
});
