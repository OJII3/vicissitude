import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEventBufferTools } from "@vicissitude/mcp/tools/event-buffer";
import { createEmotion, NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

function createStubMoodReader(mood: Emotion): MoodReader {
	return {
		getMood(_agentId: string): Emotion {
			return mood;
		},
	};
}

function createSpyMoodReader(mood: Emotion): {
	reader: MoodReader;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		reader: {
			getMood(agentId: string): Emotion {
				calls.push(agentId);
				return mood;
			},
		},
		calls,
	};
}

/**
 * wait_for_events のレスポンスは text と image が混在する可能性があるため、
 * image part 到来時に `.text` が undefined となる前提で緩い型を宣言する。
 */
type ContentPart = { type: string; text?: string };

/** registerEventBufferTools で登録された wait_for_events を直接呼び出すヘルパー */
async function callWaitForEvents(
	deps: Parameters<typeof registerEventBufferTools>[1],
): Promise<{ content: ContentPart[] }> {
	let registeredHandler: ((args: { timeout_seconds: number }) => Promise<unknown>) | undefined;

	const fakeServer = {
		registerTool(
			_name: string,
			_schema: unknown,
			handler: (args: { timeout_seconds: number }) => Promise<unknown>,
		) {
			registeredHandler = handler;
		},
	} as unknown as McpServer;

	registerEventBufferTools(fakeServer, deps);

	if (!registeredHandler) throw new Error("handler not registered");
	return (await registeredHandler({ timeout_seconds: 5 })) as { content: ContentPart[] };
}

function insertTestEvent(db: ReturnType<typeof createTestDb>, agentId: string): void {
	appendEvent(
		db,
		agentId,
		JSON.stringify({
			ts: "2026-03-28T00:00:00.000Z",
			content: "テスト発言",
			authorId: "user1",
			authorName: "テスト",
			messageId: "msg-1",
			metadata: { channelId: "ch1", channelName: "general", isMentioned: true },
		}),
	);
}

describe("wait_for_events への mood 注入", () => {
	test("MoodReader が NEUTRAL 以外の mood を返す場合、結果に <current-mood> セクションが含まれる", async () => {
		const db = createTestDb();
		const agentId = "agent-1";
		insertTestEvent(db, agentId);

		const happyMood = createEmotion(0.8, 0.5, 0.3);
		const result = await callWaitForEvents({
			db,
			agentId,
			moodReader: createStubMoodReader(happyMood),
		});

		const allText = result.content.map((c) => c.text ?? "").join("\n");
		expect(allText).toContain("<current-mood>");
		expect(allText).toContain("</current-mood>");
	});

	test("MoodReader が NEUTRAL_EMOTION を返す場合、<current-mood> セクションは含まれない", async () => {
		const db = createTestDb();
		const agentId = "agent-1";
		insertTestEvent(db, agentId);

		const result = await callWaitForEvents({
			db,
			agentId,
			moodReader: createStubMoodReader(NEUTRAL_EMOTION),
		});

		const allText = result.content.map((c) => c.text ?? "").join("\n");
		expect(allText).not.toContain("<current-mood>");
	});

	test("<current-mood> セクションは recent-messages より前（content 配列の先頭）に配置される", async () => {
		const db = createTestDb();
		const agentId = "agent-1";
		insertTestEvent(db, agentId);

		const activeMood = createEmotion(0.6, 0.4, 0.2);
		const result = await callWaitForEvents({
			db,
			agentId,
			moodReader: createStubMoodReader(activeMood),
			recentMessagesFetcher: () =>
				Promise.resolve([
					{
						authorName: "テストユーザー",
						content: "テストメッセージ",
						timestamp: new Date("2026-03-28T00:00:00.000Z"),
						reactions: [],
					},
				]),
		});

		// content 配列内で <current-mood> を含む要素のインデックスが
		// <recent-messages> を含む要素より前にあること
		const moodIndex = result.content.findIndex((c) => c.text?.includes("<current-mood>") ?? false);
		const recentIndex = result.content.findIndex(
			(c) => c.text?.includes("<recent-messages>") ?? false,
		);

		expect(moodIndex).toBeGreaterThanOrEqual(0);
		expect(recentIndex).toBeGreaterThanOrEqual(0);
		expect(moodIndex).toBeLessThan(recentIndex);
	});

	test("moodKey が指定されている場合、getMood() は agentId ではなく moodKey をキーとして呼ばれる", async () => {
		const db = createTestDb();
		const agentId = "discord:heartbeat:12345";
		insertTestEvent(db, agentId);

		const activeMood = createEmotion(0.8, 0.5, 0.3);
		const { reader, calls: readerCalls } = createSpyMoodReader(activeMood);

		await callWaitForEvents({
			db,
			agentId,
			moodReader: reader,
			moodKey: "discord:12345",
		});

		// getMood が moodKey で呼ばれ、agentId ではないことを検証
		expect(readerCalls).toHaveLength(1);
		expect(readerCalls[0]).toBe("discord:12345");
	});
});
