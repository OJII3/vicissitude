import { describe, expect, it, vi } from "vitest";
import { runOneEffect } from "./run-effect-worker.js";

const effect = {
  id: "e1",
  runId: "r1",
  guildId: "g1",
  capabilityChannelId: "c1",
  targetChannelId: "c1",
  targetMessageId: "m1",
  content: "hello",
  attempts: 1,
};
const threadEffect = { ...effect, targetChannelId: "t1" };
const clock = { now: () => new Date("2026-01-01T00:00:00Z") };

describe("runOneEffect", () => {
  it("rechecks capability and executes an allowed effect", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn() };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: true }),
    };
    const executor = { execute: vi.fn().mockResolvedValue(undefined) };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", null);
    expect(executor.execute).toHaveBeenCalledWith(effect, clock);
  });

  it("fails revoked capability without executing", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(effect), fail: vi.fn().mockResolvedValue(undefined) };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: false }),
    };
    const executor = { execute: vi.fn() };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(queue.fail).toHaveBeenCalledWith("e1", "capability_revoked", clock.now());
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("resolves capability for the thread when the target is a thread", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(threadEffect), fail: vi.fn() };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: true }),
    };
    const executor = { execute: vi.fn().mockResolvedValue(undefined) };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", "t1");
    expect(executor.execute).toHaveBeenCalledWith(threadEffect, clock);
  });

  it("fails an effect whose thread override revoked mention responses", async () => {
    const queue = { claim: vi.fn().mockResolvedValue(threadEffect), fail: vi.fn().mockResolvedValue(undefined) };
    const capabilities = {
      get: vi.fn().mockResolvedValue({ guildId: "g1", channelId: "c1", respondToMentions: false }),
    };
    const executor = { execute: vi.fn() };

    await expect(runOneEffect(queue, capabilities, executor, "worker", clock)).resolves.toBe(true);

    expect(capabilities.get).toHaveBeenCalledWith("g1", "c1", "t1");
    expect(queue.fail).toHaveBeenCalledWith("e1", "capability_revoked", clock.now());
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
