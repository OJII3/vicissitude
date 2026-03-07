import { describe, expect, it, mock } from "bun:test";

import type {
	ConsolidationResult,
	MemoryConsolidator,
} from "../../domain/ports/memory-consolidator.port.ts";
import { ConsolidateMemoryUseCase } from "./consolidate-memory.use-case.ts";
import { createMockLogger } from "./test-helpers.ts";

function emptyResult(): ConsolidationResult {
	return { processedEpisodes: 0, newFacts: 0, reinforced: 0, updated: 0, invalidated: 0 };
}

function resultWithEpisodes(n: number): ConsolidationResult {
	return { processedEpisodes: n, newFacts: 1, reinforced: 0, updated: 0, invalidated: 0 };
}

function createMockConsolidator(
	guildIds: string[],
	consolidateFn?: (guildId: string) => Promise<ConsolidationResult>,
): MemoryConsolidator {
	return {
		getActiveGuildIds: mock(() => guildIds),
		consolidate: mock(consolidateFn ?? (() => Promise.resolve(emptyResult()))),
	};
}

describe("ConsolidateMemoryUseCase", () => {
	it("アクティブなギルドがない場合、スキップログを出力して終了", async () => {
		const consolidator = createMockConsolidator([]);
		const logger = createMockLogger();
		const useCase = new ConsolidateMemoryUseCase(consolidator, logger);

		await useCase.execute();

		expect(logger.info).toHaveBeenCalledWith(
			"[ltm-consolidation] アクティブなギルドなし、スキップ",
		);
		expect(consolidator.consolidate).not.toHaveBeenCalled();
	});

	it("各ギルドに対して逐次 consolidate を呼び出す", async () => {
		const consolidator = createMockConsolidator(["111", "222"]);
		const logger = createMockLogger();
		const useCase = new ConsolidateMemoryUseCase(consolidator, logger);

		await useCase.execute();

		expect(consolidator.consolidate).toHaveBeenCalledTimes(2);
		const calls = (consolidator.consolidate as ReturnType<typeof mock>).mock.calls;
		const [firstGuildId] = calls[0] as [string];
		const [secondGuildId] = calls[1] as [string];
		expect(firstGuildId).toBe("111");
		expect(secondGuildId).toBe("222");
	});

	it("processedEpisodes > 0 の場合のみログを出力する", async () => {
		const consolidator = createMockConsolidator(["111", "222"], (guildId) => {
			if (guildId === "111") return Promise.resolve(resultWithEpisodes(3));
			return Promise.resolve(emptyResult());
		});
		const logger = createMockLogger();
		const useCase = new ConsolidateMemoryUseCase(consolidator, logger);

		await useCase.execute();

		const infoCalls = (logger.info as ReturnType<typeof mock>).mock.calls;
		const consolidationLogs = infoCalls.filter(
			(args) => typeof args[0] === "string" && args[0].includes("episodes processed"),
		);
		expect(consolidationLogs).toHaveLength(1);
		const [logMessage] = consolidationLogs[0] as [string];
		expect(logMessage).toContain("guild=111");
		expect(logMessage).toContain("3 episodes processed");
	});

	it("1 ギルド失敗しても他のギルドは処理を継続する", async () => {
		const consolidator = createMockConsolidator(["111", "222", "333"], (guildId) => {
			if (guildId === "222") return Promise.reject(new Error("DB error"));
			return Promise.resolve(resultWithEpisodes(1));
		});
		const logger = createMockLogger();
		const useCase = new ConsolidateMemoryUseCase(consolidator, logger);

		await useCase.execute();

		expect(consolidator.consolidate).toHaveBeenCalledTimes(3);
		expect(logger.error).toHaveBeenCalledTimes(1);
		const [errorMessage] = (logger.error as ReturnType<typeof mock>).mock.calls[0] as [string];
		expect(errorMessage).toContain("guild=222 failed:");
	});
});
