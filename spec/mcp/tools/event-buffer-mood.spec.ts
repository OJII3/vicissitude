import { describe, expect, test } from "bun:test";

import { createEmotion, NEUTRAL_EMOTION } from "@vicissitude/shared/emotion";
import type { Emotion } from "@vicissitude/shared/emotion";
import type { MoodReader } from "@vicissitude/shared/ports";
import { registerEventBufferTools } from "@vicissitude/mcp/tools/event-buffer";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function createStubMoodReader(mood: Emotion): MoodReader {
	return {
		getMood(_agentId: string): Emotion {
			return mood;
		},
	};
}

/** registerEventBufferTools で登録された wait_for_events を直接呼び出すヘルパー */
async function callWaitForEvents(
	deps: Parameters<typeof registerEventBufferTools>[1],
): Promise<{ content: Array<{ type: string; text: string }> }> {
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
	return (await registeredHandler({ timeout_seconds: 5 })) as {
		content: Array<{ type: string; text: string }>;
	};
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

		const allText = result.content.map((c) => c.text).join("\n");
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

		const allText = result.content.map((c) => c.text).join("\n");
		expect(allText).not.toContain("<current-mood>");
	});

	test("<current-mood> セクションは memory-context より前（content 配列の先頭）に配置される", async () => {
		const db = createTestDb();
		const agentId = "agent-1";
		insertTestEvent(db, agentId);

		const activeMood = createEmotion(0.6, 0.4, 0.2);
		const result = await callWaitForEvents({
			db,
			agentId,
			moodReader: createStubMoodReader(activeMood),
			memory: {
				retrieval: {
					retrieve: async () => ({
						episodes: [
							{
								episode: { title: "テスト", summary: "要約" } as never,
								score: 0.9,
								retrievability: 0.8,
							},
						],
						facts: [],
					}),
				} as never,
				guildId: "g1",
			},
		});

		// content 配列内で <current-mood> を含む要素のインデックスが
		// <memory-context> を含む要素より前にあること
		const moodIndex = result.content.findIndex((c) => c.text.includes("<current-mood>"));
		const memoryIndex = result.content.findIndex((c) => c.text.includes("<memory-context>"));

		expect(moodIndex).toBeGreaterThanOrEqual(0);
		expect(memoryIndex).toBeGreaterThanOrEqual(0);
		expect(moodIndex).toBeLessThan(memoryIndex);
	});
});
