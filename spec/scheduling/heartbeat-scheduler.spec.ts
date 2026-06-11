import { afterEach, describe, expect, mock, test } from "bun:test";

import { HeartbeatScheduler } from "@vicissitude/scheduling/heartbeat-scheduler";
import type { HeartbeatConfig } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";

const HEARTBEAT_TIMEOUT_MS = 180_000;

function createMockConfigRepo(config: HeartbeatConfig) {
	return {
		load: mock(() => Promise.resolve(config)),
		save: mock(() => Promise.resolve()),
		markRemindersExecuted: mock(() => Promise.resolve()),
	};
}

function flushMacrotask(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function accelerateTimeout(targetMs: number): () => void {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
		originalSetTimeout(
			handler,
			timeout === targetMs ? 0 : timeout,
			...args,
		)) as typeof globalThis.setTimeout;
	return () => {
		globalThis.setTimeout = originalSetTimeout;
	};
}

describe("HeartbeatScheduler", () => {
	let restoreSetTimeout: (() => void) | undefined;
	let restoreSetInterval: (() => void) | undefined;

	afterEach(() => {
		restoreSetTimeout?.();
		restoreSetTimeout = undefined;
		restoreSetInterval?.();
		restoreSetInterval = undefined;
	});

	test("baseIntervalMinutes を scheduler interval に反映する", async () => {
		const intervalMs: number[] = [];
		const originalSetInterval = globalThis.setInterval;
		restoreSetInterval = () => {
			globalThis.setInterval = originalSetInterval;
		};
		globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
			intervalMs.push(Number(timeout));
			return originalSetInterval(handler, timeout, ...args);
		}) as typeof globalThis.setInterval;

		const scheduler = new HeartbeatScheduler({
			configRepo: createMockConfigRepo({ baseIntervalMinutes: 5, reminders: [] }),
			heartbeatService: { execute: mock(() => Promise.resolve(new Set<string>())) },
			logger: createMockLogger(),
		});

		scheduler.start();
		await flushMacrotask();
		scheduler.stop();

		expect(intervalMs.at(-1)).toBe(5 * 60_000);
	});

	test("preFilter が返した reminders を heartbeatService.execute に渡す", async () => {
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
		const enriched = {
			reminder: {
				id: "email-check",
				description: "メール確認",
				schedule: { type: "interval" as const, minutes: 5 },
				lastExecutedAt: null,
				enabled: true,
			},
			overdueMinutes: 0,
			context: "<email_context>新着</email_context>",
		};
		const heartbeatService = {
			execute: mock((reminders: { context?: string }[]) => {
				capturedContext = reminders[0]?.context;
				return Promise.resolve(new Set(["email-check"]));
			}),
		};
		let capturedContext: string | undefined;
		const scheduler = new HeartbeatScheduler({
			configRepo,
			heartbeatService,
			logger: createMockLogger(),
			preFilter: mock(() => Promise.resolve({ reminders: [enriched] })),
		});
		const tick = scheduler as unknown as { tick(): Promise<void> };

		await tick.tick();

		expect(heartbeatService.execute).toHaveBeenCalledTimes(1);
		expect(capturedContext).toBe("<email_context>新着</email_context>");
		expect(configRepo.markRemindersExecuted).toHaveBeenCalledWith(
			["email-check"],
			expect.any(String),
		);
	});

	test("preFilter の reminders が空でも markExecutedIds があれば markRemindersExecuted を呼び execute はしない", async () => {
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
			preFilter: mock(() => Promise.resolve({ reminders: [], markExecutedIds: ["email-check"] })),
		});
		const tick = scheduler as unknown as { tick(): Promise<void> };

		await tick.tick();

		expect(heartbeatService.execute).not.toHaveBeenCalled();
		expect(configRepo.markRemindersExecuted).toHaveBeenCalledWith(
			["email-check"],
			expect.any(String),
		);
	});

	test("preFilter の reminders が空で markExecutedIds も無ければ何もしない", async () => {
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
			preFilter: mock(() => Promise.resolve({ reminders: [] })),
		});
		const tick = scheduler as unknown as { tick(): Promise<void> };

		await tick.tick();

		expect(heartbeatService.execute).not.toHaveBeenCalled();
		expect(configRepo.markRemindersExecuted).not.toHaveBeenCalled();
	});

	test("tick timeout 後も実処理が継続中なら次 tick を開始しない", async () => {
		restoreSetTimeout = accelerateTimeout(HEARTBEAT_TIMEOUT_MS);
		let resolveExecute!: () => void;
		const heartbeatService = {
			execute: mock(
				() =>
					new Promise<Set<string>>((resolve) => {
						resolveExecute = () => resolve(new Set(["due"]));
					}),
			),
		};
		const scheduler = new HeartbeatScheduler({
			configRepo: createMockConfigRepo({
				baseIntervalMinutes: 1,
				reminders: [
					{
						id: "due",
						description: "due reminder",
						schedule: { type: "interval", minutes: 1 },
						lastExecutedAt: null,
						enabled: true,
					},
				],
			}),
			heartbeatService,
			logger: createMockLogger(),
		});
		const tick = scheduler as unknown as { tick(): Promise<void> };

		await tick.tick();
		await tick.tick();

		expect(heartbeatService.execute).toHaveBeenCalledTimes(1);

		resolveExecute();
		await flushMacrotask();
	});
});
