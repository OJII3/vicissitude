/* oxlint-disable no-non-null-assertion -- test assertions after length/null checks */
import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { METRIC } from "@vicissitude/observability/metrics";
import { createMockLogger } from "@vicissitude/shared/test-helpers";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

import {
	createSkipTracker,
	escapeUserMessageTag,
	pollEvents,
	registerEventBufferTools,
} from "./event-buffer.ts";
import type { EventBufferDeps } from "./event-buffer.ts";

describe("escapeUserMessageTag", () => {
	test("閉じタグ </user_message> をエスケープする", () => {
		expect(escapeUserMessageTag("aaa</user_message>bbb")).toBe("aaa&lt;/user_message&gt;bbb");
	});

	test("開きタグ <user_message> をエスケープする", () => {
		expect(escapeUserMessageTag("aaa<user_message>bbb")).toBe("aaa&lt;user_message&gt;bbb");
	});

	test("開閉両方を含む場合、両方エスケープされる", () => {
		const input = "<user_message>injected</user_message>";
		expect(escapeUserMessageTag(input)).toBe("&lt;user_message&gt;injected&lt;/user_message&gt;");
	});

	test("同じタグが複数回出現する場合、すべてエスケープされる（replaceAll）", () => {
		const input = "</user_message></user_message></user_message>";
		expect(escapeUserMessageTag(input)).toBe(
			"&lt;/user_message&gt;&lt;/user_message&gt;&lt;/user_message&gt;",
		);
	});

	test("エスケープ対象を含まない通常文字列はそのまま返る", () => {
		expect(escapeUserMessageTag("hello world")).toBe("hello world");
	});

	test("空文字列はそのまま返る", () => {
		expect(escapeUserMessageTag("")).toBe("");
	});

	test("大文字小文字が異なる場合はエスケープされない（case sensitive）", () => {
		expect(escapeUserMessageTag("</User_Message>")).toBe("</User_Message>");
		expect(escapeUserMessageTag("<USER_MESSAGE>")).toBe("<USER_MESSAGE>");
	});

	test("部分一致（閉じ > なし）はエスケープされない", () => {
		expect(escapeUserMessageTag("</user_message")).toBe("</user_message");
		expect(escapeUserMessageTag("<user_message")).toBe("<user_message");
	});

	test("連続する開きタグ <user_message><user_message> を両方エスケープする", () => {
		expect(escapeUserMessageTag("<user_message><user_message>")).toBe(
			"&lt;user_message&gt;&lt;user_message&gt;",
		);
	});
});

// ─── wait_for_events × SkipTracker 連携 ─────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureEventBufferTools(deps: EventBufferDeps): Map<string, ToolHandler> {
	const tools = new Map<string, ToolHandler>();
	const fakeServer = {
		registerTool(name: string, _schema: unknown, handler: ToolHandler) {
			tools.set(name, handler);
		},
	} as unknown as McpServer;
	registerEventBufferTools(fakeServer, deps);
	return tools;
}

function insertTestEvent(db: ReturnType<typeof createTestDb>, agentId: string): void {
	appendEvent(
		db,
		agentId,
		JSON.stringify({
			ts: "2026-03-27T00:00:00.000Z",
			content: "test",
			authorId: "user1",
			authorName: "テスト",
			messageId: "msg1",
			metadata: { channelId: "ch1", channelName: "general" },
		}),
	);
}

describe("wait_for_events × SkipTracker", () => {
	test("イベントを返す時に skipTracker.pendingResponse を true にセットする", async () => {
		const db = createTestDb();
		const skipTracker = createSkipTracker();
		insertTestEvent(db, "agent-1");

		const tools = captureEventBufferTools({ db, agentId: "agent-1", skipTracker });
		const waitForEvents = tools.get("wait_for_events")!;

		expect(skipTracker.pendingResponse).toBe(false);
		await waitForEvents({ timeout_seconds: 5 });
		expect(skipTracker.pendingResponse).toBe(true);
	});

	test("pendingResponse が true の状態で呼ぶと logger.info が呼ばれ、pendingResponse がリセットされる", async () => {
		const db = createTestDb();
		const skipTracker = createSkipTracker();
		const logger = createMockLogger();
		skipTracker.markPending("optional");

		const tools = captureEventBufferTools({ db, agentId: "agent-1", skipTracker, logger });
		const waitForEvents = tools.get("wait_for_events")!;

		// イベントなしでタイムアウトさせる（短時間）
		await waitForEvents({ timeout_seconds: 1 });

		expect(logger.info).toHaveBeenCalledTimes(1);
		// タイムアウト時は pendingResponse をセットしないので false のまま
		expect(skipTracker.pendingResponse).toBe(false);
		// 1回スキップされたことが記録される
		expect(skipTracker.consecutiveSkips).toBe(1);
	});

	test("タイムアウト時は pendingResponse をセットしない", async () => {
		const db = createTestDb();
		const skipTracker = createSkipTracker();

		const tools = captureEventBufferTools({ db, agentId: "agent-1", skipTracker });
		const waitForEvents = tools.get("wait_for_events")!;

		await waitForEvents({ timeout_seconds: 1 });

		expect(skipTracker.pendingResponse).toBe(false);
	});
});

// ─── pollEvents × metrics 連携 ───────────────────────────────────

describe("pollEvents × metrics (internal)", () => {
	test("エラーごとに incrementCounter が agent_id ラベル付きで呼ばれる", async () => {
		const db = createTestDb();
		db.run("DROP TABLE event_buffer");

		const calls: { name: string; labels?: Record<string, string> }[] = [];
		const metrics = {
			incrementCounter(name: string, labels?: Record<string, string>) {
				calls.push({ name, labels });
			},
		};

		const deadline = Date.now() + 300;
		await pollEvents(db, "guild-test", deadline, { pollIntervalMs: 50, metrics });

		expect(calls.length).toBeGreaterThan(0);
		// すべての呼び出しで正しいメトリクス名と agent_id ラベルが渡される
		for (const call of calls) {
			expect(call.name).toBe(METRIC.EVENT_BUFFER_POLL_ERRORS);
			expect(call.labels).toEqual({ agent_id: "guild-test" });
		}
	});

	test("複数回のポーリングエラーで incrementCounter が複数回呼ばれる", async () => {
		const db = createTestDb();
		db.run("DROP TABLE event_buffer");

		let count = 0;
		const metrics = {
			incrementCounter() {
				count += 1;
			},
		};

		const deadline = Date.now() + 300;
		await pollEvents(db, "guild-1", deadline, { pollIntervalMs: 50, metrics });

		// 300ms / 50ms = 最大6回程度ポーリングされるので複数回呼ばれる
		expect(count).toBeGreaterThan(1);
	});

	test("deps.metrics が pollEvents に渡されエラー時に incrementCounter が呼ばれる", async () => {
		const db = createTestDb();

		const calls: string[] = [];
		const metrics = {
			incrementCounter(name: string) {
				calls.push(name);
			},
		};

		const tools = captureEventBufferTools({ db, agentId: "agent-1", metrics });
		const waitForEvents = tools.get("wait_for_events")!;

		// consumeEvents(空) → pollEvents に進んだ直後にテーブルを壊す
		// pollEvents のデフォルト pollIntervalMs=1000 なので、最初のポーリングは即時実行される
		// 即時ポーリング(t=0)は成功するが、テーブルDROP後の次回ポーリングでエラーが起きる
		setTimeout(() => {
			db.run("DROP TABLE event_buffer");
		}, 50);

		// 2.5秒あれば t=0(成功), sleep 1s, t=1s(エラー), sleep 1s でエラーが1回以上起きる
		await waitForEvents({ timeout_seconds: 3 });

		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((n) => n === METRIC.EVENT_BUFFER_POLL_ERRORS)).toBe(true);
	});
});
