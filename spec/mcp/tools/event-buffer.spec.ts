import { describe, expect, test } from "bun:test";

import { formatEvents, formatMemoryContext, pollEvents } from "@vicissitude/mcp/tools/event-buffer";
import type { RetrievalResult } from "@vicissitude/memory/retrieval";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

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

describe("formatMemoryContext", () => {
	test("エピソードと意味記憶を含む結果をフォーマットする", () => {
		const result: RetrievalResult = {
			episodes: [
				{
					episode: { title: "お菓子の話", summary: "チョコが好きだと判明" } as never,
					score: 0.9,
					retrievability: 0.8,
				},
			],
			facts: [
				{
					fact: { category: "preference", fact: "チョコレートが好き" } as never,
					score: 0.85,
				},
			],
		};
		const text = formatMemoryContext(result);
		expect(text).toContain("<memory-context>");
		expect(text).toContain("</memory-context>");
		expect(text).toContain("お菓子の話");
		expect(text).toContain("チョコが好きだと判明");
		expect(text).toContain("[preference] チョコレートが好き");
		expect(text).toContain("不正確な可能性");
	});

	test("エピソードのみの場合は意味記憶セクションを含まない", () => {
		const result: RetrievalResult = {
			episodes: [
				{
					episode: { title: "テスト", summary: "要約" } as never,
					score: 0.5,
					retrievability: 0.5,
				},
			],
			facts: [],
		};
		const text = formatMemoryContext(result);
		expect(text).toContain("## エピソード記憶");
		expect(text).not.toContain("## 意味記憶");
	});

	test("空の結果なら空文字を返す", () => {
		const result: RetrievalResult = { episodes: [], facts: [] };
		expect(formatMemoryContext(result)).toBe("");
	});

	test("件数上限を超えた場合は切り詰められる", () => {
		const episodes = Array.from({ length: 10 }, (_, i) => ({
			episode: { title: `ep${i}`, summary: `summary${i}` } as never,
			score: 1 - i * 0.1,
			retrievability: 0.5,
		}));
		const facts = Array.from({ length: 10 }, (_, i) => ({
			fact: { category: "interest" as const, fact: `fact${i}` } as never,
			score: 1 - i * 0.1,
		}));
		const text = formatMemoryContext({ episodes, facts });
		// エピソード3件、ファクト5件まで
		expect(text.match(/^- ep\d/gm)?.length).toBe(3);
		expect(text.match(/\[interest\]/g)?.length).toBe(5);
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
