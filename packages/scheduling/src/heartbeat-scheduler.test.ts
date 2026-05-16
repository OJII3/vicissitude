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
});
