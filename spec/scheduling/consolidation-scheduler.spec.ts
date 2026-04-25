import { describe, expect, mock, test } from "bun:test";

import { discordGuildNamespace } from "@vicissitude/memory/namespace";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import type { CriticAuditorPort } from "@vicissitude/shared/ports";
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

function createMockCriticAuditor(
	overrides: Partial<CriticAuditorPort> = {},
): CriticAuditorPort & { audit: ReturnType<typeof mock> } {
	return {
		audit: mock(() => Promise.resolve(null)),
		...overrides,
	} as CriticAuditorPort & { audit: ReturnType<typeof mock> };
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
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("no active namespaces"));
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

	describe("criticAuditor integration", () => {
		const successResult: ConsolidationResult = {
			processedEpisodes: 1,
			newFacts: 0,
			reinforced: 0,
			updated: 0,
			invalidated: 0,
		};

		test("criticAuditor 未指定 → audit 呼び出しなし", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [discordGuildNamespace("111")]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			// 第4引数を省略
			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics);
			await (scheduler as unknown as TickFn).tick();

			// consolidate は呼ばれるが audit は呼ばれない（そもそも auditor がない）
			expect(consolidator.consolidate).toHaveBeenCalledTimes(1);
			// metrics に DRIFT_AUDITS が記録されていないことを確認
			expect(metrics.incrementCounter).not.toHaveBeenCalledWith("drift_audits_total");
		});

		test("criticAuditor 指定 → consolidate 後に audit が呼ばれる", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditor = createMockCriticAuditor();
			const ns = discordGuildNamespace("222");
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [ns]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			// audit が userId = "222"（discordGuildNamespace の guildId）で呼ばれる
			expect(auditor.audit).toHaveBeenCalledTimes(1);
			expect(auditor.audit).toHaveBeenCalledWith("222");
		});

		test("audit が結果を返す → DRIFT_AUDITS メトリクスがインクリメントされる", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditor = createMockCriticAuditor({
				audit: mock(() => Promise.resolve({ severity: "minor", summary: "slightly off" })),
			});
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [discordGuildNamespace("333")]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			expect(metrics.incrementCounter).toHaveBeenCalledWith("drift_audits_total");
		});

		test('audit が severity "major" を返す → logger.warn が呼ばれる', async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditor = createMockCriticAuditor({
				audit: mock(() =>
					Promise.resolve({ severity: "major", summary: "AI assistant-like response" }),
				),
			});
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [discordGuildNamespace("444")]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("MAJOR drift detected"));
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("AI assistant-like response"),
			);
		});

		test("audit が null を返す → メトリクス・warn ともに呼ばれない", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditor = createMockCriticAuditor({
				audit: mock(() => Promise.resolve(null)),
			});
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [discordGuildNamespace("555")]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			expect(auditor.audit).toHaveBeenCalledTimes(1);
			expect(metrics.incrementCounter).not.toHaveBeenCalledWith("drift_audits_total");
			expect(logger.warn).not.toHaveBeenCalled();
		});

		test("audit が例外をスロー → error ログ出力、他 namespace は処理継続", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditError = new Error("LLM timeout");
			const auditor = createMockCriticAuditor({
				audit: mock((userId: string) => {
					if (userId === "666") return Promise.reject(auditError);
					return Promise.resolve({ severity: "minor", summary: "ok" });
				}),
			});
			const ns1 = discordGuildNamespace("666");
			const ns2 = discordGuildNamespace("777");
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [ns1, ns2]),
				consolidate: mock(() => Promise.resolve(successResult)),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			// ns1 の audit 失敗で error ログが出る
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("critic-audit"),
				auditError,
			);
			// ns2 の audit は正常に呼ばれる
			expect(auditor.audit).toHaveBeenCalledTimes(2);
			expect(auditor.audit).toHaveBeenCalledWith("777");
			// ns2 の結果がメトリクスに反映される
			expect(metrics.incrementCounter).toHaveBeenCalledWith("drift_audits_total");
		});

		test("consolidate がエラーの namespace では audit がスキップされる", async () => {
			const logger = createMockLogger();
			const metrics = createMockMetrics();
			const auditor = createMockCriticAuditor({
				audit: mock(() => Promise.resolve({ severity: "none", summary: "ok" })),
			});
			const ns1 = discordGuildNamespace("888");
			const ns2 = discordGuildNamespace("999");
			const consolidator = createMockConsolidator({
				getActiveNamespaces: mock(() => [ns1, ns2]),
				consolidate: mock((ns: { surface: string; guildId?: string }) => {
					if (ns.surface === "discord-guild" && ns.guildId === "888") {
						return Promise.reject(new Error("DB error"));
					}
					return Promise.resolve(successResult);
				}),
			});

			const scheduler = new ConsolidationScheduler(consolidator, logger, metrics, auditor);
			await (scheduler as unknown as TickFn).tick();

			// ns1 で consolidate が失敗 → audit はスキップされる
			// ns2 では consolidate 成功 → audit が呼ばれる
			expect(auditor.audit).toHaveBeenCalledTimes(1);
			expect(auditor.audit).toHaveBeenCalledWith("999");
			expect(auditor.audit).not.toHaveBeenCalledWith("888");
		});
	});
});
