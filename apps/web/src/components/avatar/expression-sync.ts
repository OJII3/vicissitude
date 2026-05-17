import type { VrmExpression, VrmExpressionWeight } from "@vicissitude/shared/emotion";

export type SyncedVrmExpression = Exclude<VrmExpression, "neutral">;

export interface VrmExpressionManagerSyncTarget {
	setValue(name: string, value: number): void;
}

const syncedVrmExpressionByName: Record<SyncedVrmExpression, true> = {
	surprised: true,
	happy: true,
	relaxed: true,
	angry: true,
	fear: true,
	sad: true,
};

export const SYNCED_VRM_EXPRESSIONS = Object.keys(
	syncedVrmExpressionByName,
) as SyncedVrmExpression[];

export function syncVrmExpression(
	manager: VrmExpressionManagerSyncTarget,
	expressionWeight: VrmExpressionWeight | null,
): void {
	for (const name of SYNCED_VRM_EXPRESSIONS) {
		manager.setValue(name, 0);
	}

	if (!expressionWeight || expressionWeight.expression === "neutral") return;

	manager.setValue(expressionWeight.expression, expressionWeight.weight);
}
