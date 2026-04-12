import { describe, expect, mock, test } from "bun:test";

import { discordGuildNamespace } from "@vicissitude/memory/namespace";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import type { ConsolidationResult, MemoryConsolidator } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

function createMockConsolidator(overrides: Partial<MemoryConsolidator> = {}): MemoryConsolidator {
	return {
		getActiveNamespaces: mock(() => []),
		consolidate: mock(() =>
			Promise.resolve({
				processedEpisodes: 0,
				newFacts: 0,
				reinforced: 0,
				updated: 0,
				invalidated: 0,
			}),
		),
		...overrides,
	};
}

type TickFn = { tick(): Promise<void> };

describe("ConsolidationScheduler", () => {
	test("アクティブギルドなし → consolidate 未呼び出し、info ログ出力", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const consolidator = createMockConsolidator();

		const scheduler = new ConsolidationScheduler(consolidator, logger, metrics);
		await (scheduler as unknown as TickFn).tick();

		expect(consolidator.consolidate).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("no active namespaces, skipping"),
		);
	});

	test("アクティブギルド 1 件 → consolidate 呼び出し、success メトリクス", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const ns = discordGuildNamespace("12345");
		const consolidator = createMockConsolidator({
			getActiveNamespaces: mock(() => [ns]),
			consolidate: mock(() =>
				Promise.resolve({
					processedEpisodes: 2,
					newFacts: 1,
					reinforced: 0,
					updated: 0,
					invalidated: 0,
				}),
			),
		});

		const scheduler = new ConsolidationScheduler(consolidator, logger, metrics);
		await (scheduler as unknown as TickFn).tick();

		expect(consolidator.consolidate).toHaveBeenCalledWith(ns);
		expect(metrics.incrementCounter).toHaveBeenCalledWith("memory_consolidation_ticks_total", {
			outcome: "success",
		});
	});

	test("consolidate がエラー → error ログ出力、他ギルドは処理継続", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const consolidateErr = new Error("DB error");
		const ns1 = discordGuildNamespace("111");
		const ns2 = discordGuildNamespace("222");
		const consolidator = createMockConsolidator({
			getActiveNamespaces: mock(() => [ns1, ns2]),
			consolidate: mock((ns: { surface: string; guildId?: string }) => {
				if (ns.surface === "discord-guild" && ns.guildId === "111") {
					return Promise.reject(consolidateErr);
				}
				return Promise.resolve({
					processedEpisodes: 1,
					newFacts: 0,
					reinforced: 0,
					updated: 0,
					invalidated: 0,
				});
			}),
		});

		const scheduler = new ConsolidationScheduler(consolidator, logger, metrics);
		await (scheduler as unknown as TickFn).tick();

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("ns=discord-guild:111 failed:"),
			consolidateErr,
		);
		// 2 番目のギルドも処理される
		expect(consolidator.consolidate).toHaveBeenCalledTimes(2);
		expect(consolidator.consolidate).toHaveBeenCalledWith(ns2);
	});

	test("tick 中に再度 tick → 排他制御で 2 回目スキップ", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		let resolveConsolidate!: () => void;
		const consolidator = createMockConsolidator({
			getActiveNamespaces: mock(() => [discordGuildNamespace("999")]),
			consolidate: mock(
				() =>
					new Promise<ConsolidationResult>((resolve) => {
						resolveConsolidate = () =>
							resolve({
								processedEpisodes: 0,
								newFacts: 0,
								reinforced: 0,
								updated: 0,
								invalidated: 0,
							});
					}),
			),
		});

		const scheduler = new ConsolidationScheduler(consolidator, logger, metrics);
		const tick = scheduler as unknown as TickFn;

		// 1 回目の tick を開始（未完了のまま保留）
		const first = tick.tick();
		// 2 回目の tick → スキップされるはず
		const second = tick.tick();

		// 2 回目は即座に完了し、スキップログが出る
		await second;
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("previous tick still running, skipping"),
		);

		// 1 回目を完了させる
		resolveConsolidate();
		await first;
	});

	test("stop() で進行中タスクを待機してから停止", async () => {
		const logger = createMockLogger();
		let resolveConsolidate!: () => void;
		const consolidator = createMockConsolidator({
			getActiveNamespaces: mock(() => [discordGuildNamespace("999")]),
			consolidate: mock(
				() =>
					new Promise<ConsolidationResult>((resolve) => {
						resolveConsolidate = () =>
							resolve({
								processedEpisodes: 0,
								newFacts: 0,
								reinforced: 0,
								updated: 0,
								invalidated: 0,
							});
					}),
			),
		});

		const scheduler = new ConsolidationScheduler(consolidator, logger);
		const tick = scheduler as unknown as TickFn;

		// tick を開始
		const tickPromise = tick.tick();
		// stop() を呼ぶ（executePromise を待つ）
		const stopPromise = scheduler.stop();

		// consolidate を完了させる
		resolveConsolidate();
		await tickPromise;
		await stopPromise;

		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("scheduler stopped"));
	});
});
