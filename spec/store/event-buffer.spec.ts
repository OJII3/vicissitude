import { describe, expect, test } from "bun:test";

import { CREATE_TABLES_SQL } from "@vicissitude/store/db";
import { SqliteEventBuffer } from "@vicissitude/store/event-buffer";
import { appendEvent } from "@vicissitude/store/queries";
import { createTestDb } from "@vicissitude/store/test-helpers";

function createMockLogger() {
	const calls = { debug: 0, info: 0, warn: 0, error: 0 };
	return {
		calls,
		logger: {
			debug: (..._args: unknown[]) => {
				calls.debug++;
			},
			info: (..._args: unknown[]) => {
				calls.info++;
			},
			warn: (..._args: unknown[]) => {
				calls.warn++;
			},
			error: (..._args: unknown[]) => {
				calls.error++;
			},
		},
	};
}

/** テスト用: DB の event_buffer テーブルを DROP してポーリングエラーを発生させる */
function breakEventBufferTable(db: ReturnType<typeof createTestDb>): void {
	db.$client.exec("DROP TABLE event_buffer");
}

/** テスト用: DB の event_buffer テーブルを再作成してエラーを解消する */
function restoreEventBufferTable(db: ReturnType<typeof createTestDb>): void {
	db.$client.exec(CREATE_TABLES_SQL);
}

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

	test("DBエラーが発生してもポーリングは継続しクラッシュしない", async () => {
		const db = createTestDb();
		const { logger } = createMockLogger();
		const buffer = new SqliteEventBuffer(db, "agent-1", logger);
		const controller = new AbortController();

		// テーブルを DROP してエラーを発生させる
		breakEventBufferTable(db);

		// 1.5秒後に abort — ポーリングがクラッシュせず継続していることを確認
		setTimeout(() => controller.abort(), 1500);

		// waitForEvents が reject せず正常に resolve すること
		await buffer.waitForEvents(controller.signal);
	}, 5_000);

	test("連続エラーが10回未満の場合は logger.warn でログ出力する", async () => {
		const db = createTestDb();
		const { calls, logger } = createMockLogger();
		const buffer = new SqliteEventBuffer(db, "agent-1", logger);
		const controller = new AbortController();

		breakEventBufferTable(db);

		// ポーリング間隔 500ms start なので、2秒で数回のポーリングが走る
		// 最初の数回は warn で出力されるはず
		setTimeout(() => controller.abort(), 2000);

		await buffer.waitForEvents(controller.signal);

		expect(calls.warn).toBeGreaterThan(0);
	}, 5_000);

	test("連続エラーが10回以上になると logger.error に昇格する", async () => {
		const db = createTestDb();
		const { calls, logger } = createMockLogger();
		const buffer = new SqliteEventBuffer(db, "agent-1", logger);
		const controller = new AbortController();

		breakEventBufferTable(db);

		// 10回以上のポーリングエラーが必要
		// 間隔: 500, 750, 1125, 1687, 2531, 3796, 5000, 5000, 5000, 5000 = 約30秒
		// 10回目に到達するまで待つ
		setTimeout(() => controller.abort(), 32_000);

		await buffer.waitForEvents(controller.signal);

		// 最初の9回は warn、10回目以降は error
		expect(calls.warn).toBe(9);
		expect(calls.error).toBeGreaterThanOrEqual(1);
	}, 40_000);

	test("エラーが解消されたら連続エラーカウントがリセットされる", async () => {
		const db = createTestDb();
		const { calls, logger } = createMockLogger();
		const buffer = new SqliteEventBuffer(db, "agent-1", logger);

		// Phase 1: テーブルを壊してエラーを数回発生させる
		breakEventBufferTable(db);
		const controller1 = new AbortController();
		setTimeout(() => controller1.abort(), 2000);
		await buffer.waitForEvents(controller1.signal);

		const warnCountAfterPhase1 = calls.warn;
		expect(warnCountAfterPhase1).toBeGreaterThan(0);

		// Phase 2: テーブルを復元し、イベントを挿入して正常に解決させる（カウントリセット）
		restoreEventBufferTable(db);
		appendEvent(db, "agent-1", '{"kind":"discord"}');
		await buffer.waitForEvents(new AbortController().signal);

		// Phase 3: 再度テーブルを壊す — カウントがリセットされているので再び warn から始まる
		breakEventBufferTable(db);
		calls.warn = 0;
		calls.error = 0;
		const controller3 = new AbortController();
		setTimeout(() => controller3.abort(), 2000);
		await buffer.waitForEvents(controller3.signal);

		// カウントリセットされているので、再び warn が出る（error ではない）
		expect(calls.warn).toBeGreaterThan(0);
		expect(calls.error).toBe(0);
	}, 10_000);
});
