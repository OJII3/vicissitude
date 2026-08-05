export interface BatchConfig {
  batchWindowMs: number;
  maxWaitMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = { batchWindowMs: 8_000, maxWaitMs: 30_000 };

/** 設計 §3.2 裁定 (2026-08-04): 後続イベントも typing も同じ式で延長する。 */
export function extendedAvailableAt(now: Date, firstTriggeredAt: Date, config: BatchConfig): Date {
  return new Date(Math.min(now.getTime() + config.batchWindowMs, firstTriggeredAt.getTime() + config.maxWaitMs));
}
