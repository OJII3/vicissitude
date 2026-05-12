import { describe, expect, mock, test } from "bun:test";

import { discordGuildNamespace } from "@vicissitude/memory/namespace";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import type { CriticAuditorPort } from "@vicissitude/shared/ports";
import type { ConsolidationResult, MemoryConsolidator } from "@vicissitude/shared/types";

import { createMockLogger, createMockMetrics } from "../test-helpers.ts";

const successResult: ConsolidationResult = {
	processedEpisodes: 1,
	newFacts: 0,
	reinforced: 0,
	updated: 0,
	invalidated: 0,
};

function createConsolidator(): MemoryConsolidator {
	return {
		getActiveNamespaces: mock(() => [discordGuildNamespace("555")]),
		consolidate: mock(() => Promise.resolve(successResult)),
	};
}

type TickFn = { tick(): Promise<void> };

describe("ConsolidationScheduler critic audit skip logging", () => {
	test("同じ critic audit skip が続く場合は warn ログを繰り返さない", async () => {
		const logger = createMockLogger();
		const metrics = createMockMetrics();
		const auditor: CriticAuditorPort = {
			audit: mock(() => Promise.resolve({ status: "skipped", reason: "no_messages" } as const)),
		};
		const scheduler = new ConsolidationScheduler(createConsolidator(), logger, metrics, auditor);

		await (scheduler as unknown as TickFn).tick();
		await (scheduler as unknown as TickFn).tick();

		expect(auditor.audit).toHaveBeenCalledTimes(2);
		expect(metrics.incrementCounter).toHaveBeenCalledWith("critic_auditor_skip_total", {
			namespace: "discord-guild:555",
			reason: "no_messages",
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			"[critic-audit] ns=discord-guild:555: skipped (no_messages)",
		);
	});
});
