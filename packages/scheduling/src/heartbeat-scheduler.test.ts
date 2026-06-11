import { describe, expect, mock, test } from "bun:test";

import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { HeartbeatConfig } from "@vicissitude/shared/types";

import { HeartbeatScheduler } from "./heartbeat-scheduler.ts";

function createMockConfigRepo(config: HeartbeatConfig) {
	return {
		load: mock(() => Promise.resolve(config)),
		save: mock(() => Promise.resolve()),
		markRemindersExecuted: mock(() => Promise.resolve()),
	};
}

function createMockHeartbeatService() {
	return {
		execute: mock(() => Promise.resolve(new Set<string>())),
	};
}

describe("HeartbeatScheduler", () => {
	test("due reminder がないときは HEARTBEAT_REMINDERS_EXECUTED を増やさない", async () => {
		const metrics = createMockMetrics();
		const scheduler = new HeartbeatScheduler({
			configRepo: createMockConfigRepo({
				baseIntervalMinutes: 30,
				reminders: [],
			}),
			heartbeatService: createMockHeartbeatService(),
			logger: createMockLogger(),
			metrics,
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(metrics.incrementCounter).not.toHaveBeenCalledWith("heartbeat_reminders_executed_total");
	});

	test("due reminder があるときだけ HEARTBEAT_REMINDERS_EXECUTED を増やす", async () => {
		const metrics = createMockMetrics();
		const configRepo = createMockConfigRepo({
			baseIntervalMinutes: 30,
			reminders: [
				{
					id: "due-1",
					description: "check home",
					schedule: { type: "interval", minutes: 1 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService: createMockHeartbeatService(),
			logger: createMockLogger(),
			metrics,
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(metrics.incrementCounter).toHaveBeenCalledWith("heartbeat_reminders_executed_total");
	});

	test("実行成功時は古い config 全体を save せず、実行済み reminder ID だけ更新する", async () => {
		const configRepo = createMockConfigRepo({
			baseIntervalMinutes: 30,
			reminders: [
				{
					id: "due-1",
					description: "check home",
					schedule: { type: "interval", minutes: 1 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		const heartbeatService = {
			execute: mock(() => Promise.resolve(new Set(["due-1"]))),
		};
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService,
			logger: createMockLogger(),
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(configRepo.save).not.toHaveBeenCalled();
		expect(configRepo.markRemindersExecuted).toHaveBeenCalledTimes(1);
		expect(configRepo.markRemindersExecuted).toHaveBeenCalledWith(["due-1"], expect.any(String));
	});

	test("execute が空 Set を返したら（成功 guild 無し）markRemindersExecuted を呼ばない", async () => {
		const configRepo = createMockConfigRepo({
			baseIntervalMinutes: 30,
			reminders: [
				{
					id: "due-1",
					description: "check home",
					schedule: { type: "interval", minutes: 1 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		const heartbeatService = {
			execute: mock(() => Promise.resolve(new Set<string>())),
		};
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService,
			logger: createMockLogger(),
		});

		// executed=true（execute は呼ばれた）だが succeededIds が空なので config 更新は無し
		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(heartbeatService.execute).toHaveBeenCalledTimes(1);
		expect(configRepo.markRemindersExecuted).not.toHaveBeenCalled();
	});

	test("preFilter 未設定なら due reminder をそのまま execute に渡す", async () => {
		const configRepo = createMockConfigRepo({
			baseIntervalMinutes: 30,
			reminders: [
				{
					id: "due-1",
					description: "check home",
					schedule: { type: "interval", minutes: 1 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		let receivedIds: string[] = [];
		const heartbeatService = {
			execute: mock((reminders: { reminder: { id: string } }[]) => {
				receivedIds = reminders.map((r) => r.reminder.id);
				return Promise.resolve(new Set(["due-1"]));
			}),
		};
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService,
			logger: createMockLogger(),
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(receivedIds).toEqual(["due-1"]);
	});

	test("preFilter の reminders が空かつ markExecutedIds が空配列なら markRemindersExecuted を呼ばない", async () => {
		// markExecutedIds.length > 0 のガードで空配列は no-op になる境界
		const configRepo = createMockConfigRepo({
			baseIntervalMinutes: 1,
			reminders: [
				{
					id: "email-check",
					description: "メール確認",
					schedule: { type: "interval", minutes: 5 },
					lastExecutedAt: null,
					enabled: true,
				},
			],
		});
		const heartbeatService = {
			execute: mock(() => Promise.resolve(new Set<string>())),
		};
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService,
			logger: createMockLogger(),
			preFilter: mock(() => Promise.resolve({ reminders: [], markExecutedIds: [] })),
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(heartbeatService.execute).not.toHaveBeenCalled();
		expect(configRepo.markRemindersExecuted).not.toHaveBeenCalled();
	});

	test("due reminder が無ければ preFilter を呼ばない", async () => {
		const preFilter = mock(() => Promise.resolve({ reminders: [] }));
		const scheduler = new HeartbeatScheduler({
			configRepo: createMockConfigRepo({ baseIntervalMinutes: 30, reminders: [] }),
			heartbeatService: createMockHeartbeatService(),
			logger: createMockLogger(),
			preFilter,
		});

		await (scheduler as unknown as { executeTick(): Promise<void> }).executeTick();

		expect(preFilter).not.toHaveBeenCalled();
	});
});
