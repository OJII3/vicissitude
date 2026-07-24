import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "./clock.js";
import { newId } from "./ids.js";

describe("clocks", () => {
  it("returns the configured instant without exposing mutable state", () => {
    const instant = new Date("2026-07-23T00:00:00.000Z");
    const clock = new FixedClock(instant);

    const first = clock.now();
    first.setUTCFullYear(2000);

    expect(clock.now()).toEqual(instant);
  });

  it("returns the current time from the system clock", () => {
    const before = Date.now();
    const now = SystemClock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

it("creates UUID-shaped IDs", () => {
  expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
