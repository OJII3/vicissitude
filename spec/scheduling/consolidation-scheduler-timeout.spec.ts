import { describe, expect, mock, test } from "bun:test";

import { discordGuildNamespace } from "@vicissitude/memory/namespace";
import { ConsolidationScheduler } from "@vicissitude/scheduling/consolidation-scheduler";
import type { ConsolidationResult, MemoryConsolidator } from "@vicissitude/shared/types";

import { createMockLogger } from "../test-helpers.ts";

const CONSOLIDATION_TIMEOUT_MS = 10 * 60_000;

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

describe("ConsolidationScheduler timeout exclusivity", () => {
	test("tick timeout 後も実処理が継続中なら次 tick を開始しない", async () => {
		const restoreSetTimeout = accelerateTimeout(CONSOLIDATION_TIMEOUT_MS);
		try {
			let resolveConsolidate!: () => void;
			const consolidator: MemoryConsolidator = {
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
			};
			const scheduler = new ConsolidationScheduler(consolidator, createMockLogger());
			const tick = scheduler as unknown as { tick(): Promise<void> };

			await tick.tick();
			await tick.tick();

			expect(consolidator.consolidate).toHaveBeenCalledTimes(1);

			resolveConsolidate();
			await flushMacrotask();
		} finally {
			restoreSetTimeout();
		}
	});
});
