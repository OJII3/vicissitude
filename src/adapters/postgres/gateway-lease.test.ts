import { describe, expect, it, vi } from "vitest";
import { acquireGatewayLease } from "./gateway-lease.js";

describe("gateway lease", () => {
  it("acquires once, rejects contention, and releases idempotently", async () => {
    const reserved = vi.fn().mockResolvedValue({
      unsafe: vi
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([]),
      release: vi.fn().mockResolvedValue(undefined),
    });
    const first = await acquireGatewayLease({ reserve: reserved } as never);
    await expect(
      acquireGatewayLease({
        reserve: vi.fn().mockResolvedValue({
          unsafe: vi.fn().mockResolvedValue([{ locked: false }]),
          release: vi.fn().mockResolvedValue(undefined),
        }),
      } as never),
    ).rejects.toThrow("already running");
    await first.release();
    await first.release();
    expect(reserved).toHaveBeenCalledOnce();
  });
});
