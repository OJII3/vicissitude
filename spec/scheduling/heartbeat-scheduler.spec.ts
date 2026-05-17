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
