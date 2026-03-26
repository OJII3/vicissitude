import { describe, expect, test } from "bun:test";

import {
	buildMemoryQuery,
	extractTypingChannels,
	formatEventMetadata,
	formatEvents,
	formatMemoryContext,
	parseEvents,
	pollEvents,
} from "@vicissitude/mcp/tools/event-buffer";
import type { RetrievalResult } from "@vicissitude/memory/retrieval";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

describe("parseEvents", () => {
	test("有効な JSON ペイロードをパースして ParsedEvent 配列を返す", () => {
		const rows = [
			{
				payload: JSON.stringify({
					ts: "2026-03-27T01:30:00.000Z",
					content: "hello",
					authorId: "user1",
					authorName: "おかず",
					messageId: "msg1",
					metadata: {
						channelId: "ch1",
						channelName: "general",
						guildId: "g1",
						isBot: false,
						isMentioned: true,
						isThread: false,
					},
				}),
			},
		];
		const result = parseEvents(rows);
		expect(result).toHaveLength(1);
		expect(result[0].ts).toBe("2026-03-27T01:30:00.000Z");
		expect(result[0].content).toBe("hello");
		expect(result[0].authorId).toBe("user1");
		expect(result[0].authorName).toBe("おかず");
		expect(result[0].messageId).toBe("msg1");
		expect(result[0].metadata?.channelId).toBe("ch1");
		expect(result[0].metadata?.channelName).toBe("general");
		expect(result[0].metadata?.isMentioned).toBe(true);
	});

	test("添付ファイルを含むペイロードをパースする", () => {
		const rows = [
			{
				payload: JSON.stringify({
					ts: "2026-03-27T01:30:00.000Z",
					content: "画像です",
					authorId: "user1",
					authorName: "テスト",
					messageId: "msg1",
					attachments: [
						{ url: "https://example.com/img.png", contentType: "image/png", filename: "img.png" },
					],
				}),
			},
		];
		const result = parseEvents(rows);
		expect(result[0].attachments).toHaveLength(1);
		expect(result[0].attachments?.[0].url).toBe("https://example.com/img.png");
	});

	test("不正な JSON ペイロードにはエラー情報を付与する", () => {
		const rows = [{ payload: "not-json" }];
		const result = parseEvents(rows);
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty("_raw", "not-json");
		expect(result[0]).toHaveProperty("_error", "invalid JSON");
	});

	test("空配列なら空配列を返す", () => {
		const result = parseEvents([]);
		expect(result).toEqual([]);
	});

	test("有効と不正が混在する場合、両方を順序通り返す", () => {
		const rows = [
			{ payload: JSON.stringify({ ts: "t1", content: "ok", authorId: "u1", authorName: "A", messageId: "m1" }) },
			{ payload: "broken" },
		];
		const result = parseEvents(rows);
		expect(result).toHaveLength(2);
		expect(result[0].content).toBe("ok");
		expect(result[1]).toHaveProperty("_error", "invalid JSON");
	});
});

describe("formatEvents", () => {
	test("ParsedEvent を人間可読形式にフォーマットする", () => {
		const events = [
			{
				ts: "2026-03-27T01:30:00.000Z",
				content: "マイクラどう？",
				authorId: "user1",
				authorName: "おかず",
				messageId: "msg1",
				metadata: {
					channelId: "ch1",
					channelName: "general",
					isMentioned: true,
				},
			},
		];
		const result = formatEvents(events);
		// JST = UTC+9 なので 01:30 UTC → 10:30 JST
		expect(result).toContain("10:30");
		expect(result).toContain("#general");
		expect(result).toContain("おかず");
		expect(result).toContain("マイクラどう？");
		expect(result).toContain("(mentioned)");
	});

	test("bot フラグを表示する", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "自動応答",
				authorId: "bot1",
				authorName: "BotA",
				messageId: "msg2",
				metadata: { isBot: true, channelName: "general" },
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("(bot)");
	});

	test("添付ファイルがあれば件数を表示する", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "画像送るよ",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg3",
				attachments: [
					{ url: "https://example.com/a.png" },
					{ url: "https://example.com/b.png" },
				],
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("[添付: 2件]");
	});

	test("空配列なら空文字列を返す", () => {
		const result = formatEvents([]);
		expect(result).toBe("");
	});

	test("不正JSONだったイベントは ERROR 形式で出力する", () => {
		const events = [
			{ _raw: "broken-data", _error: "invalid JSON" } as never,
		];
		const result = formatEvents(events);
		expect(result).toContain("[ERROR]");
		expect(result).toContain("invalid JSON");
		expect(result).toContain("broken-data");
	});

	test("タイムゾーンは JST (UTC+9) で表示する", () => {
		// 2026-03-27T15:00:00.000Z (UTC) → 2026-03-28 00:00 (JST)
		const events = [
			{
				ts: "2026-03-27T15:00:00.000Z",
				content: "深夜",
				authorId: "user1",
				authorName: "夜型",
				messageId: "msg4",
				metadata: { channelName: "general" },
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("2026-03-28");
		expect(result).toContain("00:00");
	});

	test("channelName がない場合でもエラーにならない", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "テスト",
				authorId: "user1",
				authorName: "名前",
				messageId: "msg5",
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("名前");
		expect(result).toContain("テスト");
	});

	test("複数イベントを改行区切りで出力する", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "1つ目",
				authorId: "u1",
				authorName: "A",
				messageId: "m1",
			},
			{
				ts: "2026-03-27T00:01:00.000Z",
				content: "2つ目",
				authorId: "u2",
				authorName: "B",
				messageId: "m2",
			},
		];
		const result = formatEvents(events);
		const lines = result.split("\n").filter((l) => l.trim());
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(result).toContain("1つ目");
		expect(result).toContain("2つ目");
	});
});

describe("formatEventMetadata", () => {
	test("技術的メタデータを event-metadata ブロックとして返す", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "hello",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg1",
				metadata: {
					channelId: "ch1",
					guildId: "g1",
				},
			},
		];
		const result = formatEventMetadata(events);
		expect(result).toContain("<event-metadata>");
		expect(result).toContain("</event-metadata>");
		// JSON 形式で channelId, messageId, guildId を含む
		const jsonMatch = result.match(/<event-metadata>\n?([\s\S]*?)\n?<\/event-metadata>/);
		expect(jsonMatch).not.toBeNull();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed[0].channelId).toBe("ch1");
		expect(parsed[0].messageId).toBe("msg1");
		expect(parsed[0].guildId).toBe("g1");
	});

	test("イベントがない場合は空文字列を返す", () => {
		expect(formatEventMetadata([])).toBe("");
	});
});

describe("buildMemoryQuery", () => {
	test("system イベントを除外してクエリを構築する", () => {
		const events = [
			{ ts: "", content: "internal event", authorId: "system", authorName: "", messageId: "" },
			{ ts: "", content: "こんにちは", authorId: "user1", authorName: "", messageId: "" },
		];
		expect(buildMemoryQuery(events)).toBe("こんにちは");
	});

	test("bot イベントは含める", () => {
		const events = [
			{ ts: "", content: "bot発言", authorId: "bot1", authorName: "", messageId: "", metadata: { isBot: true } },
			{ ts: "", content: "人間の発言", authorId: "user1", authorName: "", messageId: "" },
		];
		const query = buildMemoryQuery(events);
		expect(query).toContain("bot発言");
		expect(query).toContain("人間の発言");
	});

	test("content が空のイベントはスキップする", () => {
		const events = [
			{ ts: "", content: "", authorId: "user1", authorName: "", messageId: "" },
			{ ts: "", content: "有効", authorId: "user2", authorName: "", messageId: "" },
		];
		expect(buildMemoryQuery(events)).toBe("有効");
	});

	test("1000文字を超える場合は切り詰める", () => {
		const longContent = "あ".repeat(1200);
		const events = [{ ts: "", content: longContent, authorId: "user1", authorName: "", messageId: "" }];
		expect(buildMemoryQuery(events).length).toBe(1000);
	});

	test("空配列なら空文字を返す", () => {
		expect(buildMemoryQuery([])).toBe("");
	});

	test("全てが system イベントなら空文字を返す", () => {
		const events = [{ ts: "", content: "event", authorId: "system", authorName: "", messageId: "" }];
		expect(buildMemoryQuery(events)).toBe("");
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

describe("extractTypingChannels", () => {
	test("人間のイベントから channelId を抽出する", () => {
		const events = [
			{ ts: "", content: "", authorId: "user1", authorName: "", messageId: "", metadata: { channelId: "ch1", isBot: false } },
			{ ts: "", content: "", authorId: "user2", authorName: "", messageId: "", metadata: { channelId: "ch2", isBot: false } },
		];
		expect(extractTypingChannels(events)).toEqual(["ch1", "ch2"]);
	});

	test("system イベントは除外する", () => {
		const events = [
			{ ts: "", content: "", authorId: "system", authorName: "", messageId: "", metadata: { channelId: "ch1" } },
			{ ts: "", content: "", authorId: "user1", authorName: "", messageId: "", metadata: { channelId: "ch2" } },
		];
		expect(extractTypingChannels(events)).toEqual(["ch2"]);
	});

	test("bot イベントは除外する", () => {
		const events = [
			{ ts: "", content: "", authorId: "bot1", authorName: "", messageId: "", metadata: { channelId: "ch1", isBot: true } },
			{ ts: "", content: "", authorId: "user1", authorName: "", messageId: "", metadata: { channelId: "ch2", isBot: false } },
		];
		expect(extractTypingChannels(events)).toEqual(["ch2"]);
	});

	test("同一チャンネルの重複は除去する", () => {
		const events = [
			{ ts: "", content: "", authorId: "user1", authorName: "", messageId: "", metadata: { channelId: "ch1" } },
			{ ts: "", content: "", authorId: "user2", authorName: "", messageId: "", metadata: { channelId: "ch1" } },
		];
		expect(extractTypingChannels(events)).toEqual(["ch1"]);
	});

	test("metadata がないイベントはスキップする", () => {
		const events = [
			{ ts: "", content: "hello", authorId: "user1", authorName: "", messageId: "" },
		];
		expect(extractTypingChannels(events)).toEqual([]);
	});

	test("空配列なら空配列を返す", () => {
		expect(extractTypingChannels([])).toEqual([]);
	});
});

describe("pollEvents", () => {
	test("イベントが既にあれば即座に ParsedEvent 配列を返す", async () => {
		const db = createTestDb();
		appendEvent(
			db,
			"guild-1",
			JSON.stringify({ ts: "2026-03-27T00:00:00.000Z", content: "test", authorId: "u1", authorName: "A", messageId: "m1" }),
		);
		appendEvent(
			db,
			"guild-1",
			JSON.stringify({ ts: "2026-03-27T00:01:00.000Z", content: "next", authorId: "u2", authorName: "B", messageId: "m2" }),
		);

		const deadline = Date.now() + 5000;
		const result = await pollEvents(db, "guild-1", deadline);

		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
		expect(result![0].content).toBe("test");
		expect(result![1].content).toBe("next");
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
			appendEvent(
				db,
				"guild-1",
				JSON.stringify({ ts: "2026-03-27T00:00:00.000Z", content: "delayed", authorId: "u1", authorName: "A", messageId: "m1" }),
			);
		}, 50);

		const deadline = Date.now() + 500;
		const result = await pollEvents(db, "guild-1", deadline, 30);

		expect(result).not.toBeNull();
		expect(result![0].content).toBe("delayed");
	});
});
