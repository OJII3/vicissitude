import { describe, expect, it } from "bun:test";

import type { VrmExpressionWeight } from "@vicissitude/shared/emotion";

interface ExpressionManagerMock {
	readonly calls: Array<{ name: string; value: number }>;
	setValue(name: string, value: number): void;
}

interface ExpressionSyncModule {
	readonly SYNCED_VRM_EXPRESSIONS: readonly string[];
	syncVrmExpression(
		manager: ExpressionManagerMock,
		expressionWeight: VrmExpressionWeight | null,
	): void;
}

async function importExpressionSync(): Promise<ExpressionSyncModule> {
	const mod = await import("../../apps/web/src/components/avatar/expression-sync");
	return mod as ExpressionSyncModule;
}

function createExpressionManager(): ExpressionManagerMock {
	const calls: Array<{ name: string; value: number }> = [];
	return {
		calls,
		setValue(name: string, value: number) {
			calls.push({ name, value });
		},
	};
}

function latestValues(calls: ReadonlyArray<{ name: string; value: number }>): Map<string, number> {
	return new Map(calls.map((call) => [call.name, call.value]));
}

describe("avatar expression sync", () => {
	it("sync target covers every non-neutral VRM expression including fear", async () => {
		const { SYNCED_VRM_EXPRESSIONS } = await importExpressionSync();

		expect([...SYNCED_VRM_EXPRESSIONS].toSorted()).toEqual([
			"angry",
			"fear",
			"happy",
			"relaxed",
			"sad",
			"surprised",
		]);
	});

	it("resets fear and applies fear weight when avatar returns fear", async () => {
		const { syncVrmExpression } = await importExpressionSync();
		const manager = createExpressionManager();

		syncVrmExpression(manager, { expression: "fear", weight: 0.7 });

		const fearCalls = manager.calls.filter((call) => call.name === "fear");
		expect(fearCalls).toEqual([
			{ name: "fear", value: 0 },
			{ name: "fear", value: 0.7 },
		]);
		expect(latestValues(manager.calls).get("fear")).toBe(0.7);
	});

	it("neutral resets all synced expressions without applying neutral as an expression", async () => {
		const { SYNCED_VRM_EXPRESSIONS, syncVrmExpression } = await importExpressionSync();
		const manager = createExpressionManager();

		syncVrmExpression(manager, { expression: "neutral", weight: 1 });

		expect(manager.calls).toHaveLength(SYNCED_VRM_EXPRESSIONS.length);
		expect(manager.calls.some((call) => call.name === "neutral")).toBe(false);
		for (const expression of SYNCED_VRM_EXPRESSIONS) {
			expect(latestValues(manager.calls).get(expression)).toBe(0);
		}
	});
});
