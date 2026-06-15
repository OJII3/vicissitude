import { describe, expect, mock, test } from "bun:test";

import {
	type PeriodicTickConfig,
	PeriodicTickScheduler,
} from "@vicissitude/scheduling/periodic-tick-scheduler";
import type { Logger, MetricsCollector } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

const TICK_TIMEOUT_MS = 180_000;

const config: PeriodicTickConfig = {
	logPrefix: "[probe]",
	tickTimeoutMs: TICK_TIMEOUT_MS,
	timeoutMessage: "probe tick timed out",
	tickCounterMetric: "probe_ticks_total",
	tickDurationMetric: "probe_tick_duration_seconds",
};

/**
 * テスト用の最小サブクラス。`runTick` の挙動を差し替え可能にし、
 * private な `tick()` をテストから呼べるよう公開する。
 */
class ProbeScheduler extends PeriodicTickScheduler {
	constructor(
		private readonly runImpl: () => Promise<void>,
		logger: Logger,
		metrics?: MetricsCollector,
	) {
		super(config, logger, metrics);
	}

	protected runTick(): Promise<void> {
		return this.runImpl();
	}

	runTickPublic(): Promise<void> {
		return this.tick();
	}
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

describe("PeriodicTickScheduler", () => {
	test("tick が成功すると success outcome の counter と duration histogram を記録する", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const runTick = mock(() => Promise.resolve());
		const scheduler = new ProbeScheduler(runTick, logger, metrics);

		await scheduler.runTickPublic();

		expect(runTick).toHaveBeenCalledTimes(1);
		expect(metrics.incrementCounter).toHaveBeenCalledWith("probe_ticks_total", {
			outcome: "success",
		});
		expect(metrics.observeHistogram).toHaveBeenCalledWith(
			"probe_tick_duration_seconds",
			expect.any(Number),
		);
	});

	test("runTick が例外を投げると error outcome の counter と error ログを記録し、クラッシュしない", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const tickError = new Error("boom");
		const scheduler = new ProbeScheduler(() => Promise.reject(tickError), logger, metrics);

		await scheduler.runTickPublic();

		expect(metrics.incrementCounter).toHaveBeenCalledWith("probe_ticks_total", {
			outcome: "error",
		});
		expect(logger.error).toHaveBeenCalledWith("[probe] tick error:", tickError);
	});

	test("error 時も duration histogram を記録する", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const scheduler = new ProbeScheduler(() => Promise.reject(new Error("boom")), logger, metrics);

		await scheduler.runTickPublic();

		expect(metrics.observeHistogram).toHaveBeenCalledWith(
			"probe_tick_duration_seconds",
			expect.any(Number),
		);
	});

	test("前 tick 実行中に tick を呼ぶと skip ログを出し runTick を再実行しない", async () => {
		const logger = createMockLogger();
		let resolveRun!: () => void;
		const runTick = mock(
			() =>
				new Promise<void>((resolve) => {
					resolveRun = resolve;
				}),
		);
		const scheduler = new ProbeScheduler(runTick, logger);

		const first = scheduler.runTickPublic();
		const second = scheduler.runTickPublic();

		await second;
		expect(runTick).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith("[probe] previous tick still running, skipping");

		resolveRun();
		await first;
	});

	test("tick 完了後は running が解放され、次の tick で runTick を再実行する", async () => {
		const logger = createMockLogger();
		const runTick = mock(() => Promise.resolve());
		const scheduler = new ProbeScheduler(runTick, logger);

		await scheduler.runTickPublic();
		await scheduler.runTickPublic();

		expect(runTick).toHaveBeenCalledTimes(2);
	});

	test("metrics 未指定でもクラッシュしない", async () => {
		const logger = createMockLogger();
		const scheduler = new ProbeScheduler(() => Promise.resolve(), logger);

		await scheduler.runTickPublic();

		expect(logger.error).not.toHaveBeenCalled();
	});

	test("tick timeout 後も実処理が継続中なら次 tick を開始しない", async () => {
		const restoreSetTimeout = accelerateTimeout(TICK_TIMEOUT_MS);
		try {
			const logger = createMockLogger();
			let resolveRun!: () => void;
			const runTick = mock(
				() =>
					new Promise<void>((resolve) => {
						resolveRun = resolve;
					}),
			);
			const scheduler = new ProbeScheduler(runTick, logger);

			// 1 回目: timeout で抜けるが実処理は未完了 → running は解放されない
			await scheduler.runTickPublic();
			// 2 回目: 前 tick の実処理がまだ継続中なので skip される
			await scheduler.runTickPublic();

			expect(runTick).toHaveBeenCalledTimes(1);

			resolveRun();
			await flushMacrotask();
		} finally {
			restoreSetTimeout();
		}
	});
});
