/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
/* oxlint-disable max-lines -- spec file covering all event-buffer public APIs */
import { describe, expect, test } from "bun:test";

import {
	buildMemoryQuery,
	classifyActionHint,
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
		const event = result[0]!;
		expect(event.ts).toBe("2026-03-27T01:30:00.000Z");
		expect(event.content).toBe("hello");
		expect(event.authorId).toBe("user1");
		expect(event.authorName).toBe("おかず");
		expect(event.messageId).toBe("msg1");
		expect(event.metadata?.channelId).toBe("ch1");
		expect(event.metadata?.channelName).toBe("general");
		expect(event.metadata?.isMentioned).toBe(true);
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
		expect(result[0]!.attachments).toHaveLength(1);
		expect(result[0]!.attachments?.[0]?.url).toBe("https://example.com/img.png");
	});

	test("不正な JSON ペイロードにはエラー情報を付与する", () => {
		const rows = [{ payload: "not-json" }];
		const result = parseEvents(rows);
		expect(result).toHaveLength(1);
		expect(result[0]!).toHaveProperty("_raw", "not-json");
		expect(result[0]!).toHaveProperty("_error", "invalid JSON");
	});

	test("空配列なら空配列を返す", () => {
		const result = parseEvents([]);
		expect(result).toEqual([]);
	});

	test("有効と不正が混在する場合、両方を順序通り返す", () => {
		const rows = [
			{
				payload: JSON.stringify({
					ts: "t1",
					content: "ok",
					authorId: "u1",
					authorName: "A",
					messageId: "m1",
				}),
			},
			{ payload: "broken" },
		];
		const result = parseEvents(rows);
		expect(result).toHaveLength(2);
		expect(result[0]!.content).toBe("ok");
		expect(result[1]!).toHaveProperty("_error", "invalid JSON");
	});
});

describe("classifyActionHint", () => {
	test("authorId が 'system' なら 'internal' を返す", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "セッション開始",
			authorId: "system",
			authorName: "system",
			messageId: "sys1",
		};
		expect(classifyActionHint(event)).toBe("internal");
	});

	test("metadata.isBot === true なら 'read_only' を返す", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "自動応答",
			authorId: "bot1",
			authorName: "BotA",
			messageId: "msg1",
			metadata: { isBot: true },
		};
		expect(classifyActionHint(event)).toBe("read_only");
	});

	test("metadata.isMentioned === true なら 'respond' を返す", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "マイクラどう？",
			authorId: "user1",
			authorName: "おかず",
			messageId: "msg1",
			metadata: { isMentioned: true },
		};
		expect(classifyActionHint(event)).toBe("respond");
	});

	test("それ以外は 'optional' を返す", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "雑談",
			authorId: "user1",
			authorName: "おかず",
			messageId: "msg1",
			metadata: { channelName: "general" },
		};
		expect(classifyActionHint(event)).toBe("optional");
	});

	test("metadata がない場合は 'optional' を返す", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "テスト",
			authorId: "user1",
			authorName: "テスト",
			messageId: "msg1",
		};
		expect(classifyActionHint(event)).toBe("optional");
	});

	test("system は isBot よりも優先される", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "内部イベント",
			authorId: "system",
			authorName: "system",
			messageId: "sys1",
			metadata: { isBot: true },
		};
		expect(classifyActionHint(event)).toBe("internal");
	});

	test("isBot は isMentioned よりも優先される", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "bot からのメンション",
			authorId: "bot1",
			authorName: "BotA",
			messageId: "msg1",
			metadata: { isBot: true, isMentioned: true },
		};
		expect(classifyActionHint(event)).toBe("read_only");
	});

	test("system は isMentioned よりも優先される", () => {
		const event = {
			ts: "2026-03-27T00:00:00.000Z",
			content: "system メンション",
			authorId: "system",
			authorName: "system",
			messageId: "sys1",
			metadata: { isMentioned: true },
		};
		expect(classifyActionHint(event)).toBe("internal");
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
		// ユーザー発言は <user_message> タグで囲まれる
		expect(result).toContain("<user_message>マイクラどう？</user_message>");
		expect(result).toContain("[action: respond]");
	});

	test("bot イベントに [action: read_only] を表示する", () => {
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
		expect(result).toContain("[action: read_only]");
		// bot 発言には <user_message> タグが付かない
		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
	});

	test("添付ファイルがあれば件数を表示する", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "画像送るよ",
				authorId: "user1",
				authorName: "テスト",
				messageId: "msg3",
				attachments: [{ url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }],
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("[添付: 2件]");
		// 添付ファイル付きのユーザー発言もタグで囲まれる
		expect(result).toContain("<user_message>画像送るよ</user_message>");
		expect(result).toContain("[action: optional]");
	});

	test("空配列なら空文字列を返す", () => {
		const result = formatEvents([]);
		expect(result).toBe("");
	});

	test("不正JSONだったイベントは ERROR 形式で出力する", () => {
		const events = [{ _raw: "broken-data", _error: "invalid JSON" } as never];
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
		// ユーザー発言なのでタグで囲まれる
		expect(result).toContain("<user_message>深夜</user_message>");
		expect(result).toContain("[action: optional]");
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
		// channelName がなくてもユーザー発言にはタグが付く
		expect(result).toContain("<user_message>テスト</user_message>");
		expect(result).toContain("[action: optional]");
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
		// ユーザー発言はタグで囲まれる
		expect(result).toContain("<user_message>1つ目</user_message>");
		expect(result).toContain("<user_message>2つ目</user_message>");
		// 各行に action hint が付く
		for (const line of lines) {
			expect(line).toContain("[action: optional]");
		}
	});

	test("system イベントには <user_message> タグが付かない", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "セッション開始",
				authorId: "system",
				authorName: "system",
				messageId: "sys1",
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("セッション開始");
		expect(result).not.toContain("<user_message>");
		expect(result).not.toContain("</user_message>");
		expect(result).toContain("[action: internal]");
	});

	test("ユーザー発言とbot発言が混在する場合、ユーザー発言のみタグ付きである", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "こんにちは",
				authorId: "user1",
				authorName: "おかず",
				messageId: "m1",
				metadata: { channelName: "general", isBot: false },
			},
			{
				ts: "2026-03-27T00:01:00.000Z",
				content: "自動応答です",
				authorId: "bot1",
				authorName: "BotA",
				messageId: "m2",
				metadata: { channelName: "general", isBot: true },
			},
			{
				ts: "2026-03-27T00:02:00.000Z",
				content: "システム通知",
				authorId: "system",
				authorName: "system",
				messageId: "m3",
				metadata: { channelName: "general" },
			},
			{
				ts: "2026-03-27T00:03:00.000Z",
				content: "もう一つ",
				authorId: "user2",
				authorName: "たろう",
				messageId: "m4",
				metadata: { channelName: "general", isBot: false },
			},
		];
		const result = formatEvents(events);
		const lines = result.split("\n");

		// ユーザー発言はタグで囲まれる
		expect(result).toContain("<user_message>こんにちは</user_message>");
		expect(result).toContain("<user_message>もう一つ</user_message>");

		// bot 発言はタグなし
		const botLine = lines.find((l) => l.includes("BotA"));
		expect(botLine).toBeDefined();
		expect(botLine).not.toContain("<user_message>");

		// system 発言はタグなし
		const systemLine = lines.find((l) => l.includes("システム通知"));
		expect(systemLine).toBeDefined();
		expect(systemLine).not.toContain("<user_message>");

		// 各行に適切な action hint が付く
		const userLine = lines.find((l) => l.includes("おかず"));
		expect(userLine).toContain("[action: optional]");
		expect(botLine).toContain("[action: read_only]");
		expect(systemLine).toContain("[action: internal]");

		const user2Line = lines.find((l) => l.includes("たろう"));
		expect(user2Line).toContain("[action: optional]");
	});

	test("isBot が未定義のユーザー発言にもタグが付く", () => {
		const events = [
			{
				ts: "2026-03-27T00:00:00.000Z",
				content: "metadata に isBot がない",
				authorId: "user1",
				authorName: "テスト",
				messageId: "m1",
				metadata: { channelName: "general" },
			},
		];
		const result = formatEvents(events);
		expect(result).toContain("<user_message>metadata に isBot がない</user_message>");
		expect(result).toContain("[action: optional]");
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
		const parsed = JSON.parse(jsonMatch![1]!) as {
			channelId: string;
			messageId: string;
			guildId: string;
		}[];
		expect(parsed[0]!.channelId).toBe("ch1");
		expect(parsed[0]!.messageId).toBe("msg1");
		expect(parsed[0]!.guildId).toBe("g1");
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
			{
				ts: "",
				content: "bot発言",
				authorId: "bot1",
				authorName: "",
				messageId: "",
				metadata: { isBot: true },
			},
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
		const events = [
			{ ts: "", content: longContent, authorId: "user1", authorName: "", messageId: "" },
		];
		expect(buildMemoryQuery(events).length).toBe(1000);
	});

	test("空配列なら空文字を返す", () => {
		expect(buildMemoryQuery([])).toBe("");
	});

	test("全てが system イベントなら空文字を返す", () => {
		const events = [
			{ ts: "", content: "event", authorId: "system", authorName: "", messageId: "" },
		];
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
		expect(text).toContain("以下はこの会話に関連しそうな過去の記憶:");
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
			{
				ts: "",
				content: "",
				authorId: "user1",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch1", isBot: false },
			},
			{
				ts: "",
				content: "",
				authorId: "user2",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch2", isBot: false },
			},
		];
		expect(extractTypingChannels(events)).toEqual(["ch1", "ch2"]);
	});

	test("system イベントは除外する", () => {
		const events = [
			{
				ts: "",
				content: "",
				authorId: "system",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch1" },
			},
			{
				ts: "",
				content: "",
				authorId: "user1",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch2" },
			},
		];
		expect(extractTypingChannels(events)).toEqual(["ch2"]);
	});

	test("bot イベントは除外する", () => {
		const events = [
			{
				ts: "",
				content: "",
				authorId: "bot1",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch1", isBot: true },
			},
			{
				ts: "",
				content: "",
				authorId: "user1",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch2", isBot: false },
			},
		];
		expect(extractTypingChannels(events)).toEqual(["ch2"]);
	});

	test("同一チャンネルの重複は除去する", () => {
		const events = [
			{
				ts: "",
				content: "",
				authorId: "user1",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch1" },
			},
			{
				ts: "",
				content: "",
				authorId: "user2",
				authorName: "",
				messageId: "",
				metadata: { channelId: "ch1" },
			},
		];
		expect(extractTypingChannels(events)).toEqual(["ch1"]);
	});

	test("metadata がないイベントはスキップする", () => {
		const events = [{ ts: "", content: "hello", authorId: "user1", authorName: "", messageId: "" }];
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
			JSON.stringify({
				ts: "2026-03-27T00:00:00.000Z",
				content: "test",
				authorId: "u1",
				authorName: "A",
				messageId: "m1",
			}),
		);
		appendEvent(
			db,
			"guild-1",
			JSON.stringify({
				ts: "2026-03-27T00:01:00.000Z",
				content: "next",
				authorId: "u2",
				authorName: "B",
				messageId: "m2",
			}),
		);

		const deadline = Date.now() + 5000;
		const result = await pollEvents(db, "guild-1", deadline);

		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
		expect(result![0]!.content).toBe("test");
		expect(result![1]!.content).toBe("next");
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
				JSON.stringify({
					ts: "2026-03-27T00:00:00.000Z",
					content: "delayed",
					authorId: "u1",
					authorName: "A",
					messageId: "m1",
				}),
			);
		}, 50);

		const deadline = Date.now() + 500;
		const result = await pollEvents(db, "guild-1", deadline, 30);

		expect(result).not.toBeNull();
		expect(result![0]!.content).toBe("delayed");
	});
});
