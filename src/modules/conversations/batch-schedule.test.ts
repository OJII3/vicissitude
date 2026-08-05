import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_CONFIG, extendedAvailableAt } from "./batch-schedule.js";

const first = new Date("2026-08-04T00:00:00.000Z");
const config = { batchWindowMs: 8_000, maxWaitMs: 30_000 };

describe("extendedAvailableAt", () => {
  it("waits batchWindow from the latest event while under the cap", () => {
    expect(extendedAvailableAt(first, first, config)).toEqual(new Date("2026-08-04T00:00:08.000Z"));
    const later = new Date("2026-08-04T00:00:10.000Z");
    expect(extendedAvailableAt(later, first, config)).toEqual(new Date("2026-08-04T00:00:18.000Z"));
  });

  it("caps the wait at firstTriggeredAt + maxWait", () => {
    const nearCap = new Date("2026-08-04T00:00:25.000Z");
    expect(extendedAvailableAt(nearCap, first, config)).toEqual(new Date("2026-08-04T00:00:30.000Z"));
  });

  it("exposes the provisional defaults from design §3.5", () => {
    expect(DEFAULT_BATCH_CONFIG).toEqual({ batchWindowMs: 8_000, maxWaitMs: 30_000 });
  });
});
