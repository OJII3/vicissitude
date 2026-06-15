import { describe, expect, mock, test } from "bun:test";

import { METRIC } from "@vicissitude/observability/metrics";
import { agentScopeNamespace, discordScopeId } from "@vicissitude/shared/namespace";
import type { CriticAuditorPort } from "@vicissitude/shared/ports";
import { createMockLogger, createMockMetrics } from "@vicissitude/shared/test-helpers";
import type { MemoryConsolidator } from "@vicissitude/shared/types";

import { ConsolidationScheduler } from "./consolidation-scheduler.ts";

function createConsolidator(): MemoryConsolidator {
	return {
		getActiveNamespaces: mock(() => [agentScopeNamespace(discordScopeId("1234567890"))]),
		consolidate: mock(() =>
			Promise.resolve({
				processedEpisodes: 0,
				newFacts: 0,
				reinforced: 0,
				updated: 0,
				invalidated: 0,
			}),
		),
	};
}

async function executeConsolidation(scheduler: ConsolidationScheduler): Promise<void> {
	await (
		scheduler as unknown as {
			runTick(): Promise<void>;
		}
	).runTick();
}

describe("ConsolidationScheduler critic audit observability", () => {
	test("critic audit skip は reason ラベル付き counter と warn ログに出る", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const criticAuditor: CriticAuditorPort = {
			audit: mock(() => Promise.resolve({ status: "skipped", reason: "no_bot_id" } as const)),
		};
		const scheduler = new ConsolidationScheduler({
			consolidator: createConsolidator(),
			logger,
			metrics,
			criticAuditor,
		});

		await executeConsolidation(scheduler);

		expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.CRITIC_AUDITOR_SKIP_TOTAL, {
			namespace: "agent-scope:discord:guild:1234567890",
			reason: "no_bot_id",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			"[critic-audit] ns=agent-scope:discord:guild:1234567890: skipped (no_bot_id)",
		);
	});

	test("low_drift skip は drift score を更新し、warn ログを出さない", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const criticAuditor: CriticAuditorPort = {
			audit: mock(() =>
				Promise.resolve({ status: "skipped", reason: "low_drift", driftScore: 0.01 } as const),
			),
		};
		const scheduler = new ConsolidationScheduler({
			consolidator: createConsolidator(),
			logger,
			metrics,
			criticAuditor,
		});

		await executeConsolidation(scheduler);

		expect(metrics.incrementCounter).toHaveBeenCalledWith(METRIC.CRITIC_AUDITOR_SKIP_TOTAL, {
			namespace: "agent-scope:discord:guild:1234567890",
			reason: "low_drift",
		});
		expect(metrics.setGauge).toHaveBeenCalledWith(METRIC.DRIFT_SCORE, 0.01, {
			namespace: "agent-scope:discord:guild:1234567890",
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	test("同じ skip reason の warn ログは繰り返さない", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const criticAuditor: CriticAuditorPort = {
			audit: mock(() => Promise.resolve({ status: "skipped", reason: "no_messages" } as const)),
		};
		const scheduler = new ConsolidationScheduler({
			consolidator: createConsolidator(),
			logger,
			metrics,
			criticAuditor,
		});

		await executeConsolidation(scheduler);
		await executeConsolidation(scheduler);

		expect(metrics.incrementCounter).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			"[critic-audit] ns=agent-scope:discord:guild:1234567890: skipped (no_messages)",
		);
	});
});
